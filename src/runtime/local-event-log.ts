/**
 * @owner       src::runtime::local-event-log
 * @does        Persists bounded, privacy-safe diagnostic events for CLI and shared-kernel invocations.
 * @needs       user-home resolution, package version, append-only filesystem primitives
 * @feeds       usage reporting, local incident diagnosis, CLI/MCP/ACP dogfood evidence
 * @breaks      Silent write loss, unbounded retention, or high-cardinality payloads make local diagnosis incomplete or unsafe.
 * @invariants  Events contain allowlisted scalar metadata only; UTC daily files are owner-only; malformed complete records fail visibly.
 * @side-effects Appends one JSON line and prunes expired UTC day files at most once per process/day/store.
 * @perf        One bounded synchronous append per completed operation; retention scans once per UTC day.
 * @concurrency O_APPEND plus a single bounded write prevents shared-offset races between local processes.
 * @test        tests/unit/local-event-log.test.ts and tests/unit/engine/invoke.test.ts
 * @stability   additive schema v1
 * @since       2026-07-18
 */

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../constants.js";
import { userHome } from "../engine/user-home.js";

export const LOCAL_EVENT_SCHEMA_VERSION = "1" as const;
export const DEFAULT_LOG_RETENTION_DAYS = 30;
export const MAX_LOCAL_EVENT_BYTES = 16 * 1024;

export type LocalEventName =
  | "unicli.cli.invocation.completed"
  | "unicli.tool.call.completed";
export type LocalEventOutcome = "success" | "empty" | "error";
export type LocalEventSeverity = "INFO" | "WARN" | "ERROR";
export type LocalEventTransport = "cli" | "mcp" | "acp" | "bench" | "hub";

export interface LocalDiagnosticEvent {
  schema_version: typeof LOCAL_EVENT_SCHEMA_VERSION;
  event_name: LocalEventName;
  timestamp: string;
  observed_timestamp: string;
  severity_text: LocalEventSeverity;
  service_name: "unicli";
  service_version: string;
  service_revision?: string;
  invocation_id: string;
  trace_id?: string;
  transport: LocalEventTransport;
  command: string;
  site?: string;
  cmd?: string;
  strategy?: string;
  target_surface?: string;
  adapter_path?: string;
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

export interface LocalEventStore {
  rootDir: string;
  retentionDays: number;
}

export type LocalEventLogErrorCode =
  | "invalid_config"
  | "invalid_event"
  | "event_too_large"
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
  | {
      ok: true;
      path?: string;
      disabled?: true;
      maintenance_error?: LocalEventLogError;
    }
  | { ok: false; error: LocalEventLogError };

const EVENT_KEYS = new Set<keyof LocalDiagnosticEvent>([
  "schema_version",
  "event_name",
  "timestamp",
  "observed_timestamp",
  "severity_text",
  "service_name",
  "service_version",
  "service_revision",
  "invocation_id",
  "trace_id",
  "transport",
  "command",
  "site",
  "cmd",
  "strategy",
  "target_surface",
  "adapter_path",
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
]);

const prunedStoreDays = new Set<string>();
let cachedServiceRevision: string | undefined | null = null;

export function createLocalEventStore(
  options: { rootDir?: string; retentionDays?: number; homeDir?: string } = {},
): LocalEventStore {
  const retentionDays =
    options.retentionDays ??
    parseRetentionDays(process.env.UNICLI_LOG_RETENTION_DAYS);
  const rootDir =
    options.rootDir ??
    process.env.UNICLI_LOG_ROOT ??
    join(options.homeDir ?? userHome(), ".unicli", "logs", "events");
  return { rootDir, retentionDays };
}

export function localEventPath(
  store: LocalEventStore,
  timestamp: string,
): string {
  const day = utcDay(timestamp);
  return join(store.rootDir, `${day}.jsonl`);
}

export function appendLocalEvent(
  event: LocalDiagnosticEvent,
  store?: LocalEventStore,
): AppendLocalEventResult {
  if (localLoggingDisabled()) return { ok: true, disabled: true };

  let path: string | undefined;
  try {
    const resolvedStore = store ?? createLocalEventStore();
    assertLocalEvent(event);
    path = localEventPath(resolvedStore, event.timestamp);
    const line = Buffer.from(`${JSON.stringify(event)}\n`, "utf-8");
    if (line.byteLength > MAX_LOCAL_EVENT_BYTES) {
      throw new LocalEventLogError(
        "event_too_large",
        `local event exceeds ${String(MAX_LOCAL_EVENT_BYTES)} bytes`,
        path,
      );
    }

    mkdirOwnerOnly(resolvedStore.rootDir);
    appendOneWrite(path, line);
    const maintenanceError = pruneOncePerUtcDay(resolvedStore, event.timestamp);
    return {
      ok: true,
      path,
      ...(maintenanceError ? { maintenance_error: maintenanceError } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      error: asLocalEventLogError(error, path, "failed to append local event"),
    };
  }
}

export function readLocalEvents(
  store: LocalEventStore = createLocalEventStore(),
): LocalDiagnosticEvent[] {
  if (!existsSync(store.rootDir)) return [];

  let names: string[];
  try {
    names = readdirSync(store.rootDir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort();
  } catch (error) {
    throw asLocalEventLogError(
      error,
      store.rootDir,
      "failed to list local event log",
    );
  }

  const events: LocalDiagnosticEvent[] = [];
  for (const name of names) {
    const path = join(store.rootDir, name);
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (error) {
      throw asLocalEventLogError(error, path, "failed to read local event log");
    }
    const lines = raw.split(/\r?\n/);
    lines.forEach((lineText, index) => {
      if (lineText.trim().length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(lineText);
        assertLocalEvent(parsed);
      } catch (error) {
        const detail = error instanceof Error ? `: ${error.message}` : "";
        throw new LocalEventLogError(
          "malformed_jsonl",
          `malformed local event JSONL at ${path} (line ${String(index + 1)})${detail}`,
          path,
          index + 1,
        );
      }
      events.push(parsed);
    });
  }
  return events;
}

export function createLocalEvent(
  input: Omit<
    LocalDiagnosticEvent,
    | "schema_version"
    | "timestamp"
    | "observed_timestamp"
    | "severity_text"
    | "service_name"
    | "service_version"
    | "service_revision"
    | "process_id"
    | "node_version"
    | "platform"
    | "arch"
  > & { timestamp?: string },
): LocalDiagnosticEvent {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const revision = serviceRevision();
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
    ...(revision ? { service_revision: revision } : {}),
    invocation_id: input.invocation_id,
    ...(input.trace_id ? { trace_id: input.trace_id } : {}),
    transport: input.transport,
    command: input.command,
    ...(input.site ? { site: input.site } : {}),
    ...(input.cmd ? { cmd: input.cmd } : {}),
    ...(input.strategy ? { strategy: input.strategy } : {}),
    ...(input.target_surface ? { target_surface: input.target_surface } : {}),
    ...(input.adapter_path ? { adapter_path: input.adapter_path } : {}),
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
  if (!result.ok) return `[local-log] ${result.error.message}`;
  if (result.maintenance_error) {
    return `[local-log] ${result.maintenance_error.message}`;
  }
  return undefined;
}

export function isLocalLoggingEnabled(): boolean {
  return !localLoggingDisabled();
}

export function _resetLocalEventLogForTests(): void {
  prunedStoreDays.clear();
  cachedServiceRevision = null;
}

function localLoggingDisabled(): boolean {
  return (
    process.env.UNICLI_NO_LOG === "1" || process.env.UNICLI_NO_LEDGER === "1"
  );
}

function parseRetentionDays(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LOG_RETENTION_DAYS;
  if (!/^\d+$/.test(raw)) {
    throw new LocalEventLogError(
      "invalid_config",
      "UNICLI_LOG_RETENTION_DAYS must be an integer from 1 to 3650",
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 3650) {
    throw new LocalEventLogError(
      "invalid_config",
      "UNICLI_LOG_RETENTION_DAYS must be an integer from 1 to 3650",
    );
  }
  return value;
}

function utcDay(timestamp: string): string {
  const millis = Date.parse(timestamp);
  if (!Number.isFinite(millis)) {
    throw new LocalEventLogError(
      "invalid_event",
      `invalid event timestamp: ${timestamp}`,
    );
  }
  return new Date(millis).toISOString().slice(0, 10);
}

function mkdirOwnerOnly(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path, 0o700);
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
    if (process.platform !== "win32") chmodSync(path, 0o600);
    const written = writeSync(fd, line, 0, line.byteLength);
    if (written !== line.byteLength) {
      throw new LocalEventLogError(
        "io_error",
        `short local event write: ${String(written)}/${String(line.byteLength)} bytes`,
        path,
      );
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function pruneOncePerUtcDay(
  store: LocalEventStore,
  timestamp: string,
): LocalEventLogError | undefined {
  const day = utcDay(timestamp);
  const key = `${resolve(store.rootDir)}\0${day}`;
  if (prunedStoreDays.has(key)) return undefined;
  prunedStoreDays.add(key);
  try {
    const cutoffMillis =
      Date.parse(`${day}T00:00:00.000Z`) -
      (store.retentionDays - 1) * 86_400_000;
    const cutoff = new Date(cutoffMillis).toISOString().slice(0, 10);
    for (const name of readdirSync(store.rootDir)) {
      const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
      if (match && match[1] < cutoff) {
        unlinkSync(join(store.rootDir, name));
      }
    }
    return undefined;
  } catch (error) {
    return asLocalEventLogError(
      error,
      store.rootDir,
      "failed to prune expired local event logs",
    );
  }
}

function assertLocalEvent(
  value: unknown,
): asserts value is LocalDiagnosticEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalEventLogError(
      "invalid_event",
      "local event must be an object",
    );
  }
  const event = value as Record<string, unknown>;
  for (const key of Object.keys(event)) {
    if (!EVENT_KEYS.has(key as keyof LocalDiagnosticEvent)) {
      throw new LocalEventLogError(
        "invalid_event",
        `local event contains non-allowlisted field: ${key}`,
      );
    }
  }
  if (
    event.schema_version !== LOCAL_EVENT_SCHEMA_VERSION ||
    !["unicli.cli.invocation.completed", "unicli.tool.call.completed"].includes(
      String(event.event_name),
    ) ||
    event.service_name !== "unicli" ||
    typeof event.service_version !== "string" ||
    typeof event.timestamp !== "string" ||
    typeof event.observed_timestamp !== "string" ||
    typeof event.invocation_id !== "string" ||
    typeof event.command !== "string" ||
    !["cli", "mcp", "acp", "bench", "hub"].includes(String(event.transport)) ||
    !["success", "empty", "error"].includes(String(event.outcome)) ||
    typeof event.exit_code !== "number" ||
    typeof event.duration_ms !== "number"
  ) {
    throw new LocalEventLogError(
      "invalid_event",
      "local event is missing required schema-v1 fields",
    );
  }
  utcDay(event.timestamp);
  utcDay(event.observed_timestamp);
  for (const [key, field] of Object.entries(event)) {
    if (field !== undefined && typeof field === "object") {
      throw new LocalEventLogError(
        "invalid_event",
        `local event field ${key} must be scalar`,
      );
    }
    if (typeof field === "string" && Buffer.byteLength(field, "utf-8") > 1024) {
      throw new LocalEventLogError(
        "invalid_event",
        `local event field ${key} exceeds 1024 bytes`,
      );
    }
  }
}

function asLocalEventLogError(
  error: unknown,
  path: string | undefined,
  prefix: string,
): LocalEventLogError {
  if (error instanceof LocalEventLogError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new LocalEventLogError("io_error", `${prefix}: ${message}`, path);
}

function serviceRevision(): string | undefined {
  if (cachedServiceRevision !== null) return cachedServiceRevision;
  const explicit = process.env.UNICLI_BUILD_REVISION;
  if (explicit && /^[0-9a-f]{7,64}$/i.test(explicit)) {
    cachedServiceRevision = explicit.toLowerCase();
    return cachedServiceRevision;
  }
  cachedServiceRevision = revisionFromGitMetadata();
  return cachedServiceRevision;
}

function revisionFromGitMetadata(): string | undefined {
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const marker = join(current, ".git");
    if (existsSync(marker)) {
      try {
        const markerStat = statSync(marker);
        const gitDir = markerStat.isDirectory()
          ? marker
          : resolveGitDirectory(marker, readFileSync(marker, "utf-8"));
        return readGitHead(gitDir);
      } catch {
        return undefined;
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function resolveGitDirectory(marker: string, text: string): string {
  const match = /^gitdir:\s*(.+)\s*$/m.exec(text);
  if (!match) throw new Error("invalid .git file");
  return isAbsolute(match[1]) ? match[1] : resolve(dirname(marker), match[1]);
}

function readGitHead(gitDir: string): string | undefined {
  const head = readFileSync(join(gitDir, "HEAD"), "utf-8").trim();
  if (/^[0-9a-f]{40,64}$/i.test(head)) return head.toLowerCase();
  const refMatch = /^ref:\s*(.+)$/.exec(head);
  if (!refMatch) return undefined;
  const ref = refMatch[1];
  const roots = [gitDir];
  const commonDirPath = join(gitDir, "commondir");
  if (existsSync(commonDirPath)) {
    const common = readFileSync(commonDirPath, "utf-8").trim();
    roots.push(isAbsolute(common) ? common : resolve(gitDir, common));
  }
  for (const root of roots) {
    const looseRef = join(root, ref);
    if (existsSync(looseRef)) {
      const revision = readFileSync(looseRef, "utf-8").trim();
      if (/^[0-9a-f]{40,64}$/i.test(revision)) return revision.toLowerCase();
    }
    const packedRefs = join(root, "packed-refs");
    if (!existsSync(packedRefs)) continue;
    for (const line of readFileSync(packedRefs, "utf-8").split(/\r?\n/)) {
      const [revision, packedRef] = line.split(" ");
      if (packedRef === ref && /^[0-9a-f]{40,64}$/i.test(revision)) {
        return revision.toLowerCase();
      }
    }
  }
  return undefined;
}
