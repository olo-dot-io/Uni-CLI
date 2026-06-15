/**
 * @owner   src/transport/refs.ts
 * @does    Allocate, persist, and reload stable desktop element references across CLI processes.
 * @needs   filesystem, process env, home directory
 * @feeds   desktop transports, compute commands, compute ref-provenance output
 * @breaks  Lost or invalid refs prevent follow-up desktop actions from targeting prior snapshots.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface ElementRef {
  alias: string;
  stable: string;
  role: string;
  name?: string;
  value?: string;
  bounds?: { x: number; y: number; w: number; h: number };
  screenIndex?: number;
  states?: readonly string[];
  app?: string;
  pid?: number;
}

export interface RefBucket {
  byAlias: ReadonlyMap<string, ElementRef>;
  byStable: ReadonlyMap<string, ElementRef>;
  createdAt: number;
  transport: string;
  scope: string;
}

export interface ElementRefProvenance {
  provider: "unicli.compute";
  alias: string;
  stable: string;
  namespace: string;
  transport: string;
  scope: string;
  createdAt: number;
  createdAtIso: string;
  expiresAt?: number;
  expiresAtIso?: string;
  ttlMs?: number;
  role: string;
  name?: string;
  value?: string;
  bounds?: ElementRef["bounds"];
  screenIndex?: number;
  states?: readonly string[];
  app?: string;
  pid?: number;
  identity: {
    provider: "unicli.compute";
    transport: string;
    scope: string;
    app?: string;
    pid?: number;
    screenIndex?: number;
  };
}

interface SerializedRefStore {
  schema_version: 1;
  buckets: Array<{
    transport: string;
    scope: string;
    createdAt: number;
    refs: ElementRef[];
  }>;
}

export class RefAllocator {
  private counter = 0;
  private readonly byAlias = new Map<string, ElementRef>();
  private readonly byStable = new Map<string, ElementRef>();

  get size(): number {
    return this.byAlias.size;
  }

  alloc(input: Omit<ElementRef, "alias">): ElementRef {
    const existing = this.byStable.get(input.stable);
    if (existing) return existing;

    const ref: ElementRef = { ...input, alias: `@e${++this.counter}` };
    this.byAlias.set(ref.alias, ref);
    this.byStable.set(ref.stable, ref);
    return ref;
  }

  freeze(transport: string, scope: string): RefBucket {
    return {
      byAlias: new Map(this.byAlias),
      byStable: new Map(this.byStable),
      createdAt: Date.now(),
      transport,
      scope,
    };
  }
}

export class RefStore {
  private readonly latest = new Map<string, RefBucket>();

  put(bucket: RefBucket): void {
    this.latest.set(this.key(bucket.transport, bucket.scope), bucket);
  }

  resolve(alias: string): ElementRef | undefined {
    for (const bucket of this.latest.values()) {
      const ref = bucket.byAlias.get(alias);
      if (ref) return ref;
    }
    return undefined;
  }

  resolveStable(stable: string): ElementRef | undefined {
    for (const bucket of this.latest.values()) {
      const ref = bucket.byStable.get(stable);
      if (ref) return ref;
    }
    return undefined;
  }

  list(): ElementRef[] {
    return Array.from(this.latest.values()).flatMap((bucket) =>
      Array.from(bucket.byAlias.values()),
    );
  }

  buckets(): RefBucket[] {
    return Array.from(this.latest.values()).map((bucket) => ({
      byAlias: new Map(bucket.byAlias),
      byStable: new Map(bucket.byStable),
      createdAt: bucket.createdAt,
      transport: bucket.transport,
      scope: bucket.scope,
    }));
  }

  clear(): void {
    this.latest.clear();
  }

  private key(transport: string, scope: string): string {
    return `${transport}:${scope}`;
  }
}

export function computeRefsPath(): string {
  return (
    process.env.UNICLI_COMPUTE_REFS_PATH ??
    join(homedir(), ".unicli", "compute", "refs.json").replaceAll("\\", "/")
  );
}

export function saveRefStore(store: RefStore, file = computeRefsPath()): void {
  const payload: SerializedRefStore = {
    schema_version: 1,
    buckets: store.buckets().map((bucket) => ({
      transport: bucket.transport,
      scope: bucket.scope,
      createdAt: bucket.createdAt,
      refs: Array.from(bucket.byAlias.values()),
    })),
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(payload, null, 2) + "\n");
}

export function loadRefStore(file = computeRefsPath()): RefStore {
  const store = new RefStore();
  if (!existsSync(file)) return store;

  const text = readFileSync(file, "utf8").trim();
  if (!text) return store;
  const raw = JSON.parse(text) as unknown;
  if (!isSerializedRefStore(raw)) return store;

  for (const bucket of raw.buckets) {
    const byAlias = new Map<string, ElementRef>();
    const byStable = new Map<string, ElementRef>();
    for (const ref of bucket.refs) {
      byAlias.set(ref.alias, ref);
      byStable.set(ref.stable, ref);
    }
    store.put({
      byAlias,
      byStable,
      createdAt: bucket.createdAt,
      transport: bucket.transport,
      scope: bucket.scope,
    });
  }
  return store;
}

export function describeElementRef(
  ref: ElementRef,
  bucket: RefBucket,
  opts: { ttlMs?: number } = {},
): ElementRefProvenance {
  const expiresAt =
    opts.ttlMs === undefined ? undefined : bucket.createdAt + opts.ttlMs;
  return {
    provider: "unicli.compute",
    alias: ref.alias,
    stable: ref.stable,
    namespace: stableNamespace(ref.stable),
    transport: bucket.transport,
    scope: bucket.scope,
    createdAt: bucket.createdAt,
    createdAtIso: new Date(bucket.createdAt).toISOString(),
    ...(expiresAt === undefined
      ? {}
      : { expiresAt, expiresAtIso: new Date(expiresAt).toISOString() }),
    ...(opts.ttlMs === undefined ? {} : { ttlMs: opts.ttlMs }),
    role: ref.role,
    ...(ref.name === undefined ? {} : { name: ref.name }),
    ...(ref.value === undefined ? {} : { value: ref.value }),
    ...(ref.bounds === undefined ? {} : { bounds: ref.bounds }),
    ...(ref.screenIndex === undefined ? {} : { screenIndex: ref.screenIndex }),
    ...(ref.states === undefined ? {} : { states: ref.states }),
    ...(ref.app === undefined ? {} : { app: ref.app }),
    ...(ref.pid === undefined ? {} : { pid: ref.pid }),
    identity: {
      provider: "unicli.compute",
      transport: bucket.transport,
      scope: bucket.scope,
      ...(ref.app === undefined ? {} : { app: ref.app }),
      ...(ref.pid === undefined ? {} : { pid: ref.pid }),
      ...(ref.screenIndex === undefined
        ? {}
        : { screenIndex: ref.screenIndex }),
    },
  };
}

function stableNamespace(stable: string): string {
  const separator = stable.indexOf(":");
  return separator >= 0 ? stable.slice(0, separator) : "alias";
}

function isSerializedRefStore(value: unknown): value is SerializedRefStore {
  if (!isRecord(value) || value.schema_version !== 1) return false;
  if (!Array.isArray(value.buckets)) return false;
  return value.buckets.every(
    (bucket) =>
      isRecord(bucket) &&
      typeof bucket.transport === "string" &&
      typeof bucket.scope === "string" &&
      typeof bucket.createdAt === "number" &&
      Array.isArray(bucket.refs) &&
      bucket.refs.every(isElementRef),
  );
}

function isElementRef(value: unknown): value is ElementRef {
  return (
    isRecord(value) &&
    typeof value.alias === "string" &&
    typeof value.stable === "string" &&
    typeof value.role === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
