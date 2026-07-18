/**
 * @owner   src/transport/refs.ts
 * @does    Allocate, persist in target-sharded atomic records, uniquely resolve, and generation-bind stable desktop/CDP element references with their exact target identity across CLI processes.
 * @needs   filesystem, process env, home directory, recoverable cross-process file-store lock
 * @feeds   desktop transports, compute commands, compute ref-provenance output
 * @breaks  First-match alias resolution or reuse after bucket replacement can target a different application than the observed element; corrupt state and lock contention surface distinct typed errors.
 * @invariants A bare alias resolves only when exactly one current bucket owns it; every put creates a new in-process generation; captured matches become stale when their exact bucket is replaced or cleared; persisted native refs retain their exact window and persisted CDP refs retain the renderer endpoint that allocated them; empty latest buckets publish tombstones so old refs cannot revive; independent target writers cannot overwrite one another.
 * @side-effects Reads a legacy aggregate store plus target-sharded records; creates the private shard directory; atomically publishes complete replacement records for touched targets.
 * @perf    In-memory lookup is linear in live buckets; persistence is linear in retained target-bound refs; cross-process disk critical sections are short and synchronous.
 * @concurrency RefStore mutation is synchronous; disk readers and writers share one recoverable lock so pruning cannot invalidate an enumerated shard; callers can bind before an await and revalidate the exact generation afterward.
 * @test    tests/unit/refs.test.ts and tests/unit/compute-action-execution.test.ts
 * @stability stable
 * @since   2026-06-29
 */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  RecoverableFileLockError,
  withRecoverableFileStoreLock,
} from "../runtime/recoverable-file-lock.js";
import type { CdpEndpoint } from "./cdp-endpoint.js";

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
  windowId?: number | string;
  cdpEndpoint?: CdpEndpoint;
}

export interface RefBucket {
  byAlias: ReadonlyMap<string, ElementRef>;
  byStable: ReadonlyMap<string, ElementRef>;
  createdAt: number;
  transport: string;
  scope: string;
}

export interface RefStoreMatch {
  ref: ElementRef;
  bucket: RefBucket;
  generation: number;
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
  windowId?: number | string;
  cdpEndpoint?: CdpEndpoint;
  identity: {
    provider: "unicli.compute";
    transport: string;
    scope: string;
    app?: string;
    pid?: number;
    windowId?: number | string;
    screenIndex?: number;
    cdpEndpoint?: CdpEndpoint;
  };
}

export class RefStoreStateError extends Error {
  readonly minimum_capability = "compute.refs.state_corrupt";
  readonly exit_code = 78;
  readonly retryable = false;
  readonly suggestion: string;

  constructor(
    readonly statePath: string,
    cause?: unknown,
  ) {
    super(`compute ref state is corrupt at ${statePath}`, { cause });
    this.name = "RefStoreStateError";
    this.suggestion = `Move the corrupt ref state at ${statePath} aside, take a fresh compute snapshot, and retry with its new refs.`;
  }
}

export class RefStoreAccessError extends Error {
  readonly minimum_capability: string;
  readonly exit_code: number;
  readonly retryable: boolean;
  readonly suggestion: string;

  constructor(
    readonly statePath: string,
    readonly accessCode: "lock_timeout" | "lock_io",
    cause: unknown,
  ) {
    super(
      accessCode === "lock_timeout"
        ? `compute ref state is busy at ${statePath}`
        : `compute ref state lock failed at ${statePath}`,
      { cause },
    );
    this.name = "RefStoreAccessError";
    this.minimum_capability =
      accessCode === "lock_timeout"
        ? "compute.refs.lock_contention"
        : "compute.refs.lock_io";
    this.exit_code = accessCode === "lock_timeout" ? 75 : 74;
    this.retryable = accessCode === "lock_timeout";
    this.suggestion =
      accessCode === "lock_timeout"
        ? "retry after the active compute operation completes; if contention persists, run `unicli doctor compute --json`"
        : `inspect ownership and permissions for the compute ref state at ${statePath}, then take a fresh snapshot`;
  }
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
  private readonly latest = new Map<
    string,
    { bucket: RefBucket; generation: number }
  >();
  private readonly dirtyKeys = new Set<string>();
  private nextGeneration = 0;

  put(bucket: RefBucket): void {
    const key = this.key(bucket.transport, bucket.scope);
    this.latest.set(key, {
      bucket,
      generation: ++this.nextGeneration,
    });
    this.dirtyKeys.add(key);
  }

  restore(bucket: RefBucket): void {
    const key = this.key(bucket.transport, bucket.scope);
    this.latest.set(key, {
      bucket,
      generation: ++this.nextGeneration,
    });
    this.dirtyKeys.delete(key);
  }

  matches(value: string): RefStoreMatch[] {
    const matches: RefStoreMatch[] = [];
    for (const { bucket, generation } of this.latest.values()) {
      const ref = bucket.byAlias.get(value) ?? bucket.byStable.get(value);
      if (ref) matches.push({ ref, bucket, generation });
    }
    return matches;
  }

  resolve(alias: string): ElementRef | undefined {
    const matches = this.matches(alias);
    return matches.length === 1 ? matches[0]?.ref : undefined;
  }

  resolveStable(stable: string): ElementRef | undefined {
    const matches: ElementRef[] = [];
    for (const { bucket } of this.latest.values()) {
      const ref = bucket.byStable.get(stable);
      if (ref) matches.push(ref);
    }
    return matches.length === 1 ? matches[0] : undefined;
  }

  isCurrent(match: RefStoreMatch): boolean {
    const current = this.latest.get(
      this.key(match.bucket.transport, match.bucket.scope),
    );
    return (
      current?.generation === match.generation &&
      current.bucket.byStable.get(match.ref.stable) === match.ref
    );
  }

  list(): ElementRef[] {
    return Array.from(this.latest.values()).flatMap(({ bucket }) =>
      Array.from(bucket.byAlias.values()),
    );
  }

  buckets(): RefBucket[] {
    return Array.from(this.latest.values()).map(({ bucket }) => ({
      byAlias: new Map(bucket.byAlias),
      byStable: new Map(bucket.byStable),
      createdAt: bucket.createdAt,
      transport: bucket.transport,
      scope: bucket.scope,
    }));
  }

  persistenceCandidates(): Array<{
    key: string;
    bucket: RefBucket;
    generation: number;
  }> {
    return Array.from(this.dirtyKeys).flatMap((key) => {
      const current = this.latest.get(key);
      return current ? [{ key, ...current }] : [];
    });
  }

  markPersisted(key: string, generation: number): void {
    if (this.latest.get(key)?.generation === generation) {
      this.dirtyKeys.delete(key);
    }
  }

  clear(): void {
    this.latest.clear();
    this.dirtyKeys.clear();
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
  const candidates = store.persistenceCandidates();
  if (candidates.length === 0) return;
  const recordDirectory = `${file}.d`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  mkdirSync(recordDirectory, { recursive: true, mode: 0o700 });
  withRefStoreLock(file, recordDirectory, () => {
    for (const { key, bucket: liveBucket, generation } of candidates) {
      const bucket = serializedBucket(liveBucket);
      publishBucketRecord(recordDirectory, bucket);
      store.markPersisted(key, generation);
    }
  });
}

export function loadRefStore(file = computeRefsPath()): RefStore {
  const store = new RefStore();
  const recordDirectory = `${file}.d`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  mkdirSync(recordDirectory, { recursive: true, mode: 0o700 });
  const latest = withRefStoreLock(file, recordDirectory, () =>
    latestSerializedBuckets(file),
  );
  for (const bucket of latest.values()) {
    const persistedRefs = bucket.refs.filter((ref) =>
      isPersistableRef(ref, bucket.transport, bucket.scope),
    );
    if (persistedRefs.length === 0) continue;
    const byAlias = new Map<string, ElementRef>();
    const byStable = new Map<string, ElementRef>();
    for (const ref of persistedRefs) {
      byAlias.set(ref.alias, ref);
      byStable.set(ref.stable, ref);
    }
    store.restore({
      byAlias,
      byStable,
      createdAt: bucket.createdAt,
      transport: bucket.transport,
      scope: bucket.scope,
    });
  }
  return store;
}

type SerializedRefBucket = SerializedRefStore["buckets"][number];

function withRefStoreLock<T>(
  file: string,
  recordDirectory: string,
  operation: () => T,
): T {
  try {
    return withRecoverableFileStoreLock(recordDirectory, operation);
  } catch (error) {
    const lockError = findRecoverableFileLockError(error);
    if (!lockError) throw error;
    throw new RefStoreAccessError(
      file,
      lockError.code === "lock_timeout" ? "lock_timeout" : "lock_io",
      error,
    );
  }
}

function findRecoverableFileLockError(
  error: unknown,
): RecoverableFileLockError | undefined {
  if (error instanceof RecoverableFileLockError) return error;
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const found = findRecoverableFileLockError(nested);
      if (found) return found;
    }
  }
  return error instanceof Error
    ? findRecoverableFileLockError(error.cause)
    : undefined;
}

function serializedBucket(bucket: RefBucket): SerializedRefBucket {
  return {
    transport: bucket.transport,
    scope: bucket.scope,
    createdAt: bucket.createdAt,
    refs: Array.from(bucket.byAlias.values()).filter((ref) =>
      isPersistableRef(ref, bucket.transport, bucket.scope),
    ),
  };
}

function publishBucketRecord(
  recordDirectory: string,
  bucket: SerializedRefBucket,
): void {
  const key = bucketRecordKey(bucket.transport, bucket.scope);
  const payload = `${JSON.stringify({ schema_version: 1, buckets: [bucket] } satisfies SerializedRefStore, null, 2)}\n`;
  const payloadDigest = createHash("sha256").update(payload).digest("hex");
  const monotonicOrder = process.hrtime.bigint().toString().padStart(20, "0");
  const finalPath = join(
    recordDirectory,
    `${key}.${String(bucket.createdAt).padStart(16, "0")}.${monotonicOrder}.${String(process.pid).padStart(10, "0")}.${payloadDigest}.json`,
  );
  if (existsSync(finalPath)) {
    pruneOlderBucketRecords(recordDirectory, key, basename(finalPath));
    return;
  }

  const temporaryPath = join(
    recordDirectory,
    `.${key}.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  let temporaryExists = false;
  try {
    writeFileSync(temporaryPath, payload, { flag: "wx", mode: 0o600 });
    temporaryExists = true;
    try {
      linkSync(temporaryPath, finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    unlinkSync(temporaryPath);
    temporaryExists = false;
    pruneOlderBucketRecords(recordDirectory, key, basename(finalPath));
  } catch (error) {
    if (temporaryExists) removeRefStagingFile(temporaryPath, error);
    throw error;
  }
}

function pruneOlderBucketRecords(
  recordDirectory: string,
  key: string,
  candidateName: string,
): void {
  const records = readdirSync(recordDirectory)
    .filter((name) => name.startsWith(`${key}.`) && name.endsWith(".json"))
    .sort(compareBucketRecordNames);
  const newest = records.at(-1);
  if (!newest) return;
  for (const name of records) {
    if (name !== newest && name !== candidateName) {
      unlinkRefRecordIfPresent(join(recordDirectory, name));
    }
  }
  if (candidateName !== newest) {
    unlinkRefRecordIfPresent(join(recordDirectory, candidateName));
  }
}

function unlinkRefRecordIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function compareBucketRecordNames(left: string, right: string): number {
  const leftCreatedAt = bucketRecordCreatedAt(left);
  const rightCreatedAt = bucketRecordCreatedAt(right);
  return leftCreatedAt - rightCreatedAt || left.localeCompare(right);
}

function bucketRecordCreatedAt(name: string): number {
  const fields = name.split(".");
  const value = Number(fields[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : -1;
}

function removeRefStagingFile(path: string, original: unknown): void {
  try {
    unlinkSync(path);
  } catch (cleanupError) {
    if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new AggregateError(
        [original, cleanupError],
        "Compute ref publication and staging cleanup both failed",
      );
    }
  }
}

function latestSerializedBuckets(
  file: string,
): Map<string, SerializedRefBucket> {
  const latest = new Map<
    string,
    { bucket: SerializedRefBucket; sourcePriority: number; source: string }
  >();
  const accept = (
    payload: SerializedRefStore,
    sourcePriority: number,
    source: string,
  ): void => {
    for (const bucket of payload.buckets) {
      const key = refBucketKey(bucket.transport, bucket.scope);
      const current = latest.get(key);
      if (
        !current ||
        bucket.createdAt > current.bucket.createdAt ||
        (bucket.createdAt === current.bucket.createdAt &&
          (sourcePriority > current.sourcePriority ||
            (sourcePriority === current.sourcePriority &&
              source.localeCompare(current.source) > 0)))
      ) {
        latest.set(key, { bucket, sourcePriority, source });
      }
    }
  };

  const legacy = readSerializedRefStore(file);
  if (legacy) accept(legacy, 0, basename(file));
  const recordDirectory = `${file}.d`;
  if (existsSync(recordDirectory)) {
    for (const entry of readdirSync(recordDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const payload = readSerializedRefStore(join(recordDirectory, entry.name));
      if (payload) accept(payload, 1, entry.name);
    }
  }
  return new Map(
    Array.from(latest, ([key, value]) => [key, value.bucket] as const),
  );
}

function readSerializedRefStore(file: string): SerializedRefStore | undefined {
  try {
    const text = readFileSync(file, "utf8").trim();
    const raw = text ? (JSON.parse(text) as unknown) : undefined;
    if (isSerializedRefStore(raw)) return raw;
    throw new TypeError("ref state does not match schema version 1");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof RefStoreStateError) throw error;
    throw new RefStoreStateError(file, error);
  }
}

function bucketRecordKey(transport: string, scope: string): string {
  return createHash("sha256")
    .update(refBucketKey(transport, scope))
    .digest("hex")
    .slice(0, 32);
}

function refBucketKey(transport: string, scope: string): string {
  return `${transport}\0${scope}`;
}

function isPersistableRef(
  ref: ElementRef,
  transport: string,
  scope: string,
): boolean {
  if (isNativeDesktopTransport(transport)) {
    return Boolean(ref.app && hasExactNativeRefScope(ref, transport, scope));
  }
  if (transport === "cdp-browser") {
    return Boolean(ref.cdpEndpoint?.webSocketDebuggerUrl);
  }
  return true;
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
    ...(ref.windowId === undefined ? {} : { windowId: ref.windowId }),
    ...(ref.cdpEndpoint === undefined ? {} : { cdpEndpoint: ref.cdpEndpoint }),
    identity: {
      provider: "unicli.compute",
      transport: bucket.transport,
      scope: bucket.scope,
      ...(ref.app === undefined ? {} : { app: ref.app }),
      ...(ref.pid === undefined ? {} : { pid: ref.pid }),
      ...(ref.windowId === undefined ? {} : { windowId: ref.windowId }),
      ...(ref.cdpEndpoint === undefined
        ? {}
        : { cdpEndpoint: ref.cdpEndpoint }),
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
      isNonNegativeSafeInteger(bucket.createdAt) &&
      Array.isArray(bucket.refs) &&
      bucket.refs.every(isElementRef),
  );
}

function isElementRef(value: unknown): value is ElementRef {
  return (
    isRecord(value) &&
    typeof value.alias === "string" &&
    typeof value.stable === "string" &&
    typeof value.role === "string" &&
    (value.name === undefined || typeof value.name === "string") &&
    (value.value === undefined || typeof value.value === "string") &&
    (value.app === undefined || typeof value.app === "string") &&
    (value.pid === undefined || isPositiveSafeInteger(value.pid)) &&
    (value.windowId === undefined || isNativeWindowId(value.windowId)) &&
    (value.screenIndex === undefined ||
      isNonNegativeSafeInteger(value.screenIndex)) &&
    (value.states === undefined ||
      (Array.isArray(value.states) &&
        value.states.every((state) => typeof state === "string"))) &&
    (value.bounds === undefined || isBounds(value.bounds)) &&
    (value.cdpEndpoint === undefined || isCdpEndpoint(value.cdpEndpoint))
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNativeWindowId(value: unknown): value is number | string {
  return (
    isPositiveSafeInteger(value) ||
    (typeof value === "string" && value.trim().length > 0)
  );
}

function isNativeDesktopTransport(transport: string): boolean {
  return (
    transport === "desktop-ax" ||
    transport === "desktop-uia" ||
    transport === "desktop-atspi"
  );
}

function hasExactNativeRefScope(
  ref: ElementRef,
  transport: string,
  bucketScope: string,
): boolean {
  if (ref.windowId === undefined) return false;
  const exactScope = `window-${String(ref.windowId).toLowerCase()}`;
  const stablePrefix = `${transport}:${exactScope}:`;
  return (
    ref.stable.toLowerCase().startsWith(stablePrefix.toLowerCase()) &&
    (bucketScope === "desktop" ||
      bucketScope.toLowerCase() === exactScope.toLowerCase())
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBounds(value: unknown): value is NonNullable<ElementRef["bounds"]> {
  return (
    isRecord(value) &&
    [value.x, value.y, value.w, value.h].every(
      (coordinate) =>
        typeof coordinate === "number" && Number.isFinite(coordinate),
    )
  );
}

function isCdpEndpoint(value: unknown): value is CdpEndpoint {
  return (
    isRecord(value) &&
    isPositiveSafeInteger(value.port) &&
    value.port <= 65_535 &&
    (value.webSocketDebuggerUrl === undefined ||
      isWebSocketUrl(value.webSocketDebuggerUrl)) &&
    (value.targetId === undefined ||
      (typeof value.targetId === "string" && value.targetId.trim().length > 0))
  );
}

function isWebSocketUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "ws:" || protocol === "wss:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
