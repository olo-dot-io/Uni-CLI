/**
 * @owner       src::runtime::local-event-log
 * @does        Persists and strictly reads versioned, bounded, privacy-safe terminal diagnostic events.
 * @needs       source identity, recoverable event-store lock, user-home resolution, package version, synchronous filesystem primitives
 * @feeds       usage reporting, local incident diagnosis, CLI/MCP/ACP dogfood evidence
 * @breaks      Invalid schemas, quota exhaustion, lock contention, or filesystem failures surface as typed local-log errors.
 * @invariants  Schema-v2 writes and schema-v1/v2 reads are closed and scalar-only; retained JSONL bytes never exceed daily or total caps; readers reject symlinks, non-files, and identities that change after inspection; explicit existing roots keep their mode.
 * @side-effects Serializes readers and writers with a recoverable process-held lock, prunes expired UTC files before append, and writes one bounded JSON line.
 * @perf        O(retained day files) maintenance per append and O(retained bytes) per read; no resident daemon.
 * @concurrency One exclusive store lock makes prune, quota admission, append, and reads serializable across cooperating processes.
 * @test        tests/unit/local-event-log.test.ts and tests/unit/engine/invoke.test.ts
 * @stability   schema v2 writes with strict schema v1 read compatibility
 * @since       2026-07-18
 */

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { VERSION } from "../constants.js";
import { userHome } from "../engine/user-home.js";
import {
  _resetSourceIdentityForTests,
  serviceSourceIdentity,
  type ServiceSourceState,
} from "./source-identity.js";
import {
  RecoverableFileLockError,
  withRecoverableFileStoreLock,
} from "./recoverable-file-lock.js";

export const LOCAL_EVENT_SCHEMA_VERSION = "2" as const;
export const LEGACY_LOCAL_EVENT_SCHEMA_VERSION = "1" as const;
export const DEFAULT_LOG_RETENTION_DAYS = 30;
export const MAX_LOCAL_EVENT_BYTES = 16 * 1024;
export const MAX_LOCAL_DAY_BYTES = 16 * 1024 * 1024;
export const MAX_LOCAL_TOTAL_BYTES = 128 * 1024 * 1024;

const DAY_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const MAX_SCALAR_STRING_BYTES = 1024;

export type LocalEventName =
  | "unicli.cli.invocation.completed"
  | "unicli.tool.call.completed";
export type LocalEventOutcome = "success" | "empty" | "error";
export type LocalEventSeverity = "INFO" | "WARN" | "ERROR";
export type LocalEventTransport = "cli" | "mcp" | "acp" | "bench" | "hub";
export type LocalEventOperationRole =
  | "invocation"
  | "direct"
  | "nested"
  | "standalone";

interface LocalDiagnosticFields {
  event_name: LocalEventName;
  timestamp: string;
  observed_timestamp: string;
  severity_text: LocalEventSeverity;
  service_name: "unicli";
  service_version: string;
  service_revision?: string;
  source_state?: ServiceSourceState;
  source_digest?: string;
  invocation_id: string;
  trace_id?: string;
  transport: LocalEventTransport;
  command: string;
  site?: string;
  cmd?: string;
  strategy?: string;
  target_surface?: string;
  outcome: LocalEventOutcome;
  exit_code: number;
  duration_ms: number;
  result_count?: number;
  result_bytes?: number;
  error_type?: string;
  retryable?: boolean;
  error_step?: number;
  outcome_ambiguous?: boolean;
  target_unusable?: boolean;
  provider?: string;
  profile_source?: string;
  process_id: number;
  node_version: string;
  platform: string;
  arch: string;
}

export interface LocalDiagnosticEventV1 extends LocalDiagnosticFields {
  schema_version: typeof LEGACY_LOCAL_EVENT_SCHEMA_VERSION;
  adapter_path?: string;
}

export interface LocalDiagnosticEventV2 extends LocalDiagnosticFields {
  schema_version: typeof LOCAL_EVENT_SCHEMA_VERSION;
  parent_invocation_id?: string;
  operation_role: LocalEventOperationRole;
}

export type LocalDiagnosticEvent =
  | LocalDiagnosticEventV1
  | LocalDiagnosticEventV2;

export interface LocalEventStore {
  rootDir: string;
  retentionDays: number;
  preserveExistingRootMode?: boolean;
}

export interface ReadLocalEventsOptions {
  now?: number;
}

interface InspectedLocalEventFile {
  path: string;
  dev: number;
  ino: number;
  size: number;
}

export type LocalEventLogErrorCode =
  | "invalid_config"
  | "invalid_event"
  | "event_too_large"
  | "capacity_exceeded"
  | "lock_timeout"
  | "malformed_jsonl"
  | "io_error";

export class LocalEventLogError extends Error {
  constructor(
    public readonly code: LocalEventLogErrorCode,
    message: string,
    public readonly path?: string,
    public readonly line?: number,
  ) {
    super(message);
    this.name = "LocalEventLogError";
  }
}

export type AppendLocalEventResult =
  | { ok: true; path?: string; disabled?: true }
  | { ok: false; error: LocalEventLogError };

const COMMON_EVENT_KEYS = [
  "schema_version",
  "event_name",
  "timestamp",
  "observed_timestamp",
  "severity_text",
  "service_name",
  "service_version",
  "service_revision",
  "source_state",
  "source_digest",
  "invocation_id",
  "trace_id",
  "transport",
  "command",
  "site",
  "cmd",
  "strategy",
  "target_surface",
  "outcome",
  "exit_code",
  "duration_ms",
  "result_count",
  "result_bytes",
  "error_type",
  "retryable",
  "error_step",
  "outcome_ambiguous",
  "target_unusable",
  "provider",
  "profile_source",
  "process_id",
  "node_version",
  "platform",
  "arch",
] as const;
const V1_EVENT_KEYS = new Set<string>([...COMMON_EVENT_KEYS, "adapter_path"]);
const V2_EVENT_KEYS = new Set<string>([
  ...COMMON_EVENT_KEYS,
  "parent_invocation_id",
  "operation_role",
]);
const OPTIONAL_STRING_KEYS = [
  "service_revision",
  "trace_id",
  "site",
  "cmd",
  "strategy",
  "target_surface",
  "error_type",
  "provider",
  "profile_source",
] as const;
const OPTIONAL_BOOLEAN_KEYS = [
  "retryable",
  "outcome_ambiguous",
  "target_unusable",
] as const;
const OPTIONAL_INTEGER_KEYS = [
  "result_count",
  "result_bytes",
  "error_step",
] as const;

export function createLocalEventStore(
  options: { rootDir?: string; retentionDays?: number; homeDir?: string } = {},
): LocalEventStore {
  const retentionDays = validateRetentionDays(
    options.retentionDays ??
      parseRetentionDays(process.env.UNICLI_LOG_RETENTION_DAYS),
  );
  const configuredRoot = options.rootDir ?? process.env.UNICLI_LOG_ROOT;
  const rootDir =
    configuredRoot ??
    join(options.homeDir ?? userHome(), ".unicli", "logs", "events");
  if (rootDir.trim().length === 0) {
    throw new LocalEventLogError(
      "invalid_config",
      "local event root must not be empty",
    );
  }
  return {
    rootDir,
    retentionDays,
    preserveExistingRootMode: configuredRoot !== undefined,
  };
}

export function localEventPath(
  store: LocalEventStore,
  timestamp: string,
): string {
  return join(store.rootDir, utcDay(timestamp) + ".jsonl");
}

export function appendLocalEvent(
  event: LocalDiagnosticEventV2,
  store?: LocalEventStore,
): AppendLocalEventResult {
  if (localLoggingDisabled()) return { ok: true, disabled: true };

  let path: string | undefined;
  try {
    const resolvedStore = store ?? createLocalEventStore();
    assertCurrentLocalEvent(event);
    path = localEventPath(resolvedStore, event.timestamp);
    const line = Buffer.from(JSON.stringify(event) + "\n", "utf-8");
    if (line.byteLength > MAX_LOCAL_EVENT_BYTES) {
      throw new LocalEventLogError(
        "event_too_large",
        "local event exceeds " + String(MAX_LOCAL_EVENT_BYTES) + " bytes",
        path,
      );
    }

    ensureEventRoot(resolvedStore);
    withRecoverableFileStoreLock(resolvedStore.rootDir, () => {
      const now = Date.now();
      pruneExpiredFiles(resolvedStore, now);
      assertStoreCapacity(resolvedStore, path!, line.byteLength);
      appendOneWrite(path!, line);
    });
    return { ok: true, path };
  } catch (error) {
    return {
      ok: false,
      error: asLocalEventLogError(error, path, "failed to append local event"),
    };
  }
}

export function readLocalEvents(
  store: LocalEventStore = createLocalEventStore(),
  options: ReadLocalEventsOptions = {},
): LocalDiagnosticEvent[] {
  if (!existsSync(store.rootDir)) return [];
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) {
    throw new LocalEventLogError(
      "invalid_config",
      "local event read time must be finite",
      store.rootDir,
    );
  }

  try {
    return withRecoverableFileStoreLock(store.rootDir, () => {
      const files = inspectRetainedEventFiles(
        retainedEventFileNames(store, now).map((name) =>
          join(store.rootDir, name),
        ),
      );
      const events: LocalDiagnosticEvent[] = [];
      for (const file of files) {
        const path = file.path;
        let raw: string;
        try {
          raw = readInspectedLocalEventFile(file);
        } catch (error) {
          throw asLocalEventLogError(
            error,
            path,
            "failed to read local event log",
          );
        }
        const lines = raw.split(/\r?\n/);
        lines.forEach((lineText, index) => {
          if (lineText.trim().length === 0) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(lineText);
            assertStoredLocalEvent(parsed);
          } catch (error) {
            const detail = error instanceof Error ? ": " + error.message : "";
            throw new LocalEventLogError(
              "malformed_jsonl",
              "malformed local event JSONL at " +
                path +
                " (line " +
                String(index + 1) +
                ")" +
                detail,
              path,
              index + 1,
            );
          }
          events.push(parsed);
        });
      }
      return events;
    });
  } catch (error) {
    throw asLocalEventLogError(
      error,
      store.rootDir,
      "failed to read local event log",
    );
  }
}

export function createLocalEvent(
  input: Omit<
    LocalDiagnosticEventV2,
    | "schema_version"
    | "timestamp"
    | "observed_timestamp"
    | "severity_text"
    | "service_name"
    | "service_version"
    | "service_revision"
    | "source_state"
    | "source_digest"
    | "process_id"
    | "node_version"
    | "platform"
    | "arch"
  > & { timestamp?: string },
): LocalDiagnosticEventV2 {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const sourceIdentity = serviceSourceIdentity();
  return {
    schema_version: LOCAL_EVENT_SCHEMA_VERSION,
    event_name: input.event_name,
    timestamp,
    observed_timestamp: new Date().toISOString(),
    severity_text:
      input.outcome === "error"
        ? "ERROR"
        : input.outcome === "empty"
          ? "WARN"
          : "INFO",
    service_name: "unicli",
    service_version: VERSION,
    ...(sourceIdentity.revision
      ? { service_revision: sourceIdentity.revision }
      : {}),
    ...(sourceIdentity.state ? { source_state: sourceIdentity.state } : {}),
    ...(sourceIdentity.digest ? { source_digest: sourceIdentity.digest } : {}),
    invocation_id: input.invocation_id,
    ...(input.parent_invocation_id
      ? { parent_invocation_id: input.parent_invocation_id }
      : {}),
    ...(input.trace_id ? { trace_id: input.trace_id } : {}),
    transport: input.transport,
    command: input.command,
    ...(input.site ? { site: input.site } : {}),
    ...(input.cmd ? { cmd: input.cmd } : {}),
    ...(input.strategy ? { strategy: input.strategy } : {}),
    ...(input.target_surface ? { target_surface: input.target_surface } : {}),
    operation_role: input.operation_role,
    outcome: input.outcome,
    exit_code: input.exit_code,
    duration_ms: input.duration_ms,
    ...(input.result_count !== undefined
      ? { result_count: input.result_count }
      : {}),
    ...(input.result_bytes !== undefined
      ? { result_bytes: input.result_bytes }
      : {}),
    ...(input.error_type ? { error_type: input.error_type } : {}),
    ...(input.retryable !== undefined ? { retryable: input.retryable } : {}),
    ...(input.error_step !== undefined ? { error_step: input.error_step } : {}),
    ...(input.outcome_ambiguous !== undefined
      ? { outcome_ambiguous: input.outcome_ambiguous }
      : {}),
    ...(input.target_unusable !== undefined
      ? { target_unusable: input.target_unusable }
      : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.profile_source ? { profile_source: input.profile_source } : {}),
    process_id: process.pid,
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}

export function localEventWarning(
  result: AppendLocalEventResult,
): string | undefined {
  return result.ok ? undefined : "[local-log] " + result.error.message;
}

export function isLocalLoggingEnabled(): boolean {
  return !localLoggingDisabled();
}

export function _resetLocalEventLogForTests(): void {
  _resetSourceIdentityForTests();
}

function localLoggingDisabled(): boolean {
  return (
    process.env.UNICLI_NO_LOG === "1" || process.env.UNICLI_NO_LEDGER === "1"
  );
}

function parseRetentionDays(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LOG_RETENTION_DAYS;
  if (!/^\d+$/.test(raw)) throw invalidRetentionConfig();
  return Number(raw);
}

function validateRetentionDays(retentionDays: number): number {
  if (
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > 3650
  ) {
    throw invalidRetentionConfig();
  }
  return retentionDays;
}

function invalidRetentionConfig(): LocalEventLogError {
  return new LocalEventLogError(
    "invalid_config",
    "UNICLI_LOG_RETENTION_DAYS must be an integer from 1 to 3650",
  );
}

function utcDay(timestamp: string): string {
  const millis = Date.parse(timestamp);
  if (!Number.isFinite(millis)) {
    throw new LocalEventLogError(
      "invalid_event",
      "invalid event timestamp: " + timestamp,
    );
  }
  return new Date(millis).toISOString().slice(0, 10);
}

function retentionCutoffDay(retentionDays: number, now: number): string {
  const currentDay = utcDay(new Date(now).toISOString());
  const cutoffMillis =
    Date.parse(currentDay + "T00:00:00.000Z") -
    (retentionDays - 1) * 86_400_000;
  return new Date(cutoffMillis).toISOString().slice(0, 10);
}

function ensureEventRoot(store: LocalEventStore): void {
  const existed = existsSync(store.rootDir);
  mkdirSync(store.rootDir, { recursive: true, mode: 0o700 });
  if (
    process.platform !== "win32" &&
    (!existed || store.preserveExistingRootMode !== true)
  ) {
    chmodSync(store.rootDir, 0o700);
  }
}

function retainedEventFileNames(store: LocalEventStore, now: number): string[] {
  const cutoff = retentionCutoffDay(store.retentionDays, now);
  let names: string[];
  try {
    names = readdirSync(store.rootDir);
  } catch (error) {
    throw asLocalEventLogError(
      error,
      store.rootDir,
      "failed to list local event log",
    );
  }
  return names
    .filter((name) => {
      const match = DAY_FILE_PATTERN.exec(name);
      return match !== null && match[1] >= cutoff;
    })
    .sort();
}

function inspectRetainedEventFiles(
  paths: readonly string[],
): InspectedLocalEventFile[] {
  let totalBytes = 0;
  const files = paths.map((path) => {
    const stats = lstatSync(path);
    if (!stats.isFile()) {
      throw new LocalEventLogError(
        "io_error",
        "local event path is not a regular file: " + path,
        path,
      );
    }
    if (stats.size > MAX_LOCAL_DAY_BYTES) {
      throw new LocalEventLogError(
        "capacity_exceeded",
        "local event day exceeds " + String(MAX_LOCAL_DAY_BYTES) + " bytes",
        path,
      );
    }
    totalBytes += stats.size;
    return { path, dev: stats.dev, ino: stats.ino, size: stats.size };
  });
  if (totalBytes > MAX_LOCAL_TOTAL_BYTES) {
    throw new LocalEventLogError(
      "capacity_exceeded",
      "local event store exceeds " + String(MAX_LOCAL_TOTAL_BYTES) + " bytes",
      paths[0],
    );
  }
  return files;
}

function readInspectedLocalEventFile(file: InspectedLocalEventFile): string {
  const noFollow =
    typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  let readFailure: unknown;
  let bytes: Buffer | undefined;
  try {
    fd = openSync(file.path, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== file.dev ||
      opened.ino !== file.ino ||
      opened.size !== file.size
    ) {
      throw new LocalEventLogError(
        "io_error",
        "local event file identity changed after inspection: " + file.path,
        file.path,
      );
    }
    bytes = readFileSync(fd);
    if (bytes.byteLength !== file.size) {
      throw new LocalEventLogError(
        "io_error",
        "local event file size changed while reading: " + file.path,
        file.path,
      );
    }
  } catch (error) {
    readFailure = error;
  }

  let closeFailure: unknown;
  if (fd !== undefined) {
    try {
      closeSync(fd);
    } catch (error) {
      closeFailure = error;
    }
  }
  if (readFailure !== undefined && closeFailure !== undefined) {
    throw new AggregateError(
      [readFailure, closeFailure],
      "local event read and file close both failed",
    );
  }
  if (readFailure !== undefined) throw readFailure;
  if (closeFailure !== undefined) throw closeFailure;
  return bytes!.toString("utf-8");
}

function pruneExpiredFiles(store: LocalEventStore, now: number): void {
  const cutoff = retentionCutoffDay(store.retentionDays, now);
  for (const name of readdirSync(store.rootDir)) {
    const match = DAY_FILE_PATTERN.exec(name);
    if (match && match[1] < cutoff) unlinkSync(join(store.rootDir, name));
  }
}

function assertStoreCapacity(
  store: LocalEventStore,
  targetPath: string,
  appendBytes: number,
): void {
  let dayBytes = 0;
  let totalBytes = 0;
  for (const name of readdirSync(store.rootDir)) {
    if (!DAY_FILE_PATTERN.test(name)) continue;
    const path = join(store.rootDir, name);
    const fileStat = lstatSync(path);
    if (!fileStat.isFile()) {
      throw new LocalEventLogError(
        "io_error",
        "local event path is not a regular file: " + path,
        path,
      );
    }
    totalBytes += fileStat.size;
    if (resolve(path) === resolve(targetPath)) dayBytes = fileStat.size;
  }
  if (dayBytes + appendBytes > MAX_LOCAL_DAY_BYTES) {
    throw new LocalEventLogError(
      "capacity_exceeded",
      "local event day exceeds " + String(MAX_LOCAL_DAY_BYTES) + " bytes",
      targetPath,
    );
  }
  if (totalBytes + appendBytes > MAX_LOCAL_TOTAL_BYTES) {
    throw new LocalEventLogError(
      "capacity_exceeded",
      "local event store exceeds " + String(MAX_LOCAL_TOTAL_BYTES) + " bytes",
      store.rootDir,
    );
  }
}

function appendOneWrite(path: string, line: Buffer): void {
  const noFollow =
    typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const flags =
    fsConstants.O_APPEND |
    fsConstants.O_CREAT |
    fsConstants.O_WRONLY |
    noFollow;
  let fd: number | undefined;
  try {
    fd = openSync(path, flags, 0o600);
    const fileStat = fstatSync(fd);
    if (!fileStat.isFile()) {
      throw new LocalEventLogError(
        "io_error",
        "local event path is not a regular file: " + path,
        path,
      );
    }
    if (process.platform !== "win32") chmodSync(path, 0o600);
    const written = writeSync(fd, line, 0, line.byteLength);
    if (written !== line.byteLength) {
      throw new LocalEventLogError(
        "io_error",
        "short local event write: " +
          String(written) +
          "/" +
          String(line.byteLength) +
          " bytes",
        path,
      );
    }
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertCurrentLocalEvent(
  value: unknown,
): asserts value is LocalDiagnosticEventV2 {
  assertStoredLocalEvent(value);
  if (value.schema_version !== LOCAL_EVENT_SCHEMA_VERSION) {
    throw new LocalEventLogError(
      "invalid_event",
      "new local events must use schema version 2",
    );
  }
}

function assertStoredLocalEvent(
  value: unknown,
): asserts value is LocalDiagnosticEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalEventLogError(
      "invalid_event",
      "local event must be an object",
    );
  }
  const event = value as Record<string, unknown>;
  const schemaVersion = event.schema_version;
  const allowedKeys =
    schemaVersion === LEGACY_LOCAL_EVENT_SCHEMA_VERSION
      ? V1_EVENT_KEYS
      : schemaVersion === LOCAL_EVENT_SCHEMA_VERSION
        ? V2_EVENT_KEYS
        : undefined;
  if (!allowedKeys) {
    throw new LocalEventLogError(
      "invalid_event",
      "local event has an unsupported schema version",
    );
  }
  for (const key of Object.keys(event)) {
    if (!allowedKeys.has(key)) {
      throw new LocalEventLogError(
        "invalid_event",
        "local event contains non-allowlisted field: " + key,
      );
    }
  }

  assertRequiredString(event, "timestamp");
  assertRequiredString(event, "observed_timestamp");
  assertCanonicalTimestamp(event.timestamp, "timestamp");
  assertCanonicalTimestamp(event.observed_timestamp, "observed_timestamp");
  assertEnum(event, "event_name", [
    "unicli.cli.invocation.completed",
    "unicli.tool.call.completed",
  ]);
  assertEnum(event, "severity_text", ["INFO", "WARN", "ERROR"]);
  assertEnum(event, "transport", ["cli", "mcp", "acp", "bench", "hub"]);
  assertEnum(event, "outcome", ["success", "empty", "error"]);
  if (event.service_name !== "unicli") {
    throw invalidField("service_name", "must equal unicli");
  }
  for (const key of [
    "service_version",
    "invocation_id",
    "command",
    "node_version",
    "platform",
    "arch",
  ] as const) {
    assertRequiredString(event, key);
  }
  for (const key of OPTIONAL_STRING_KEYS) assertOptionalString(event, key);
  assertOptionalString(event, "source_digest");
  if (event.source_state !== undefined) {
    assertEnum(event, "source_state", [
      "clean",
      "dirty",
      "unknown",
      "packaged",
    ]);
  }
  if (
    event.source_digest !== undefined &&
    (event.source_state !== "dirty" ||
      !/^[0-9a-f]{64}$/.test(event.source_digest as string))
  ) {
    throw invalidField(
      "source_digest",
      "must be a lowercase SHA-256 digest present only for dirty source",
    );
  }
  assertInteger(event, "exit_code", 0, 255);
  assertFiniteNonNegative(event, "duration_ms");
  assertInteger(event, "process_id", 1, Number.MAX_SAFE_INTEGER);
  for (const key of OPTIONAL_INTEGER_KEYS) assertOptionalInteger(event, key);
  for (const key of OPTIONAL_BOOLEAN_KEYS) assertOptionalBoolean(event, key);
  const expectedSeverity =
    event.outcome === "error"
      ? "ERROR"
      : event.outcome === "empty"
        ? "WARN"
        : "INFO";
  if (event.severity_text !== expectedSeverity) {
    throw invalidField("severity_text", "must equal " + expectedSeverity);
  }

  if (schemaVersion === LEGACY_LOCAL_EVENT_SCHEMA_VERSION) {
    assertOptionalString(event, "adapter_path");
    return;
  }
  assertOptionalString(event, "parent_invocation_id");
  assertEnum(event, "operation_role", [
    "invocation",
    "direct",
    "nested",
    "standalone",
  ]);
  const role = event.operation_role;
  const hasParent = typeof event.parent_invocation_id === "string";
  if ((role === "direct" || role === "nested") !== hasParent) {
    throw invalidField(
      "parent_invocation_id",
      "is required exactly for direct and nested operations",
    );
  }
}

function assertRequiredString(
  event: Record<string, unknown>,
  key: string,
): void {
  const field = event[key];
  if (typeof field !== "string" || field.length === 0) {
    throw invalidField(key, "must be a non-empty string");
  }
  assertBoundedString(key, field);
}

function assertOptionalString(
  event: Record<string, unknown>,
  key: string,
): void {
  const field = event[key];
  if (field === undefined) return;
  if (typeof field !== "string" || field.length === 0) {
    throw invalidField(key, "must be a non-empty string when present");
  }
  assertBoundedString(key, field);
}

function assertBoundedString(key: string, field: string): void {
  if (Buffer.byteLength(field, "utf-8") > MAX_SCALAR_STRING_BYTES) {
    throw invalidField(
      key,
      "exceeds " + String(MAX_SCALAR_STRING_BYTES) + " bytes",
    );
  }
}

function assertEnum(
  event: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): void {
  if (
    typeof event[key] !== "string" ||
    !allowed.includes(event[key] as string)
  ) {
    throw invalidField(key, "must be one of " + allowed.join(", "));
  }
}

function assertCanonicalTimestamp(timestamp: unknown, key: string): void {
  if (typeof timestamp !== "string") {
    throw invalidField(key, "must be a string");
  }
  const millis = Date.parse(timestamp);
  if (
    !Number.isFinite(millis) ||
    new Date(millis).toISOString() !== timestamp
  ) {
    throw invalidField(key, "must be a canonical UTC ISO-8601 timestamp");
  }
}

function assertFiniteNonNegative(
  event: Record<string, unknown>,
  key: string,
): void {
  const field = event[key];
  if (typeof field !== "number" || !Number.isFinite(field) || field < 0) {
    throw invalidField(key, "must be a finite non-negative number");
  }
}

function assertInteger(
  event: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): void {
  const field = event[key];
  if (
    typeof field !== "number" ||
    !Number.isSafeInteger(field) ||
    field < minimum ||
    field > maximum
  ) {
    throw invalidField(
      key,
      "must be a safe integer from " +
        String(minimum) +
        " to " +
        String(maximum),
    );
  }
}

function assertOptionalInteger(
  event: Record<string, unknown>,
  key: string,
): void {
  if (event[key] === undefined) return;
  assertInteger(event, key, 0, Number.MAX_SAFE_INTEGER);
}

function assertOptionalBoolean(
  event: Record<string, unknown>,
  key: string,
): void {
  if (event[key] !== undefined && typeof event[key] !== "boolean") {
    throw invalidField(key, "must be boolean when present");
  }
}

function invalidField(key: string, requirement: string): LocalEventLogError {
  return new LocalEventLogError(
    "invalid_event",
    "local event field " + key + " " + requirement,
  );
}

function asLocalEventLogError(
  error: unknown,
  path: string | undefined,
  prefix: string,
): LocalEventLogError {
  if (error instanceof LocalEventLogError) return error;
  if (error instanceof RecoverableFileLockError) {
    return new LocalEventLogError(error.code, error.message, error.path);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new LocalEventLogError("io_error", prefix + ": " + message, path);
}
