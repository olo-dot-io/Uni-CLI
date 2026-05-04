import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * Element-ref allocator. Each snapshot gets short monotonic aliases (`@e1`)
 * backed by stable transport tokens so later actions can dereference either
 * form without reparsing encoded text.
 */

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
    join(homedir(), ".unicli", "compute", "refs.json")
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
