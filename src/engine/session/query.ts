import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { BrowserSessionLease } from "../browser/session-lease.js";
import { runTracePath, type RunStore, RunStoreError } from "./store.js";
import type { PublicRunEvent, RunEvent, RunId } from "./types.js";

export type RunTraceStatus =
  | "completed"
  | "failed"
  | "running"
  | "empty"
  | "unreadable";

export interface RunSummary {
  run_id: RunId;
  command?: string;
  status: RunTraceStatus;
  events: number;
  started_at?: string;
  finished_at?: string;
  updated_at?: string;
  duration_ms?: number;
  transport_surface?: string;
  target_surface?: string;
  browser_session_id?: string;
  browser_workspace_id?: string;
  browser_target_kind?: string;
  browser_target_id?: string;
  browser_tab_id?: number;
  browser_window_id?: number;
  browser_auth_state?: string;
  browser_cookie_count?: number;
  lease_owner?: string;
  lease_scope?: string;
  error_code?: string;
  runtime_permission_denied?: RunSummaryRuntimePermissionDenied;
}

export interface RunSummaryRuntimePermissionDenied {
  code?: string;
  action?: string;
  step?: number;
  rule_id?: string;
  resource_buckets?: string[];
  retryable?: boolean;
}

export async function listRunSummaries(store: RunStore): Promise<RunSummary[]> {
  const entries = await readdir(store.rootDir, { withFileTypes: true }).catch(
    () => [],
  );
  const summaries = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => await summarizeRunId(store, entry.name)),
  );

  return summaries
    .filter((summary): summary is RunSummary => summary !== null)
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
}

export async function summarizeRunId(
  store: RunStore,
  runId: RunId,
): Promise<RunSummary | null> {
  let tracePath: string;
  try {
    tracePath = runTracePath(store, runId);
  } catch (err) {
    if (err instanceof RunStoreError && err.code === "invalid_run_id") {
      return null;
    }
    throw err;
  }

  const traceStat = await stat(tracePath).catch(() => null);
  if (!traceStat) return null;

  try {
    return await summarizeRunTraceFile(tracePath, {
      runId,
      updatedAt: traceStat.mtime.toISOString(),
    });
  } catch (err) {
    return {
      run_id: runId,
      status: "unreadable",
      events: 0,
      updated_at: traceStat.mtime.toISOString(),
      error_code: err instanceof RunStoreError ? err.code : "io_error",
    };
  }
}

export function summarizeRunEvents(
  events: RunEvent[],
  options: { runId?: RunId; updatedAt?: string } = {},
): RunSummary {
  const scan: RunEventScan = { first: events[0], events: events.length };
  for (const event of events) {
    if (!scan.started && event.name === "run.started") {
      scan.started = event;
    }
    if (event.name === "run.completed" || event.name === "run.failed") {
      scan.terminal = event;
    }
    if (event.name === "permission.runtime_denied") {
      scan.runtimePermissionDenied = event;
    }
  }
  return summarizeRunEventScan(scan, options);
}

interface RunEventScan {
  first?: RunEvent;
  started?: RunEvent;
  terminal?: RunEvent;
  runtimePermissionDenied?: RunEvent;
  events: number;
}

async function summarizeRunTraceFile(
  tracePath: string,
  options: { runId?: RunId; updatedAt?: string } = {},
): Promise<RunSummary> {
  const scan: RunEventScan = { events: 0 };
  const lines = createInterface({
    input: createReadStream(tracePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;

  try {
    for await (const lineText of lines) {
      lineNumber += 1;
      if (lineText.trim().length === 0) continue;
      let event: RunEvent;
      try {
        event = JSON.parse(lineText) as RunEvent;
      } catch {
        throw new RunStoreError(
          "malformed_jsonl",
          `malformed run trace JSONL at line ${lineNumber}`,
          tracePath,
          lineNumber,
        );
      }

      scan.events += 1;
      scan.first ??= event;
      if (!scan.started && event.name === "run.started") {
        scan.started = event;
      }
      if (event.name === "run.completed" || event.name === "run.failed") {
        scan.terminal = event;
      }
      if (event.name === "permission.runtime_denied") {
        scan.runtimePermissionDenied = event;
      }
    }
  } catch (err) {
    if (err instanceof RunStoreError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new RunStoreError(
      "io_error",
      `failed to read run events: ${message}`,
      tracePath,
    );
  }

  return summarizeRunEventScan(scan, options);
}

function summarizeRunEventScan(
  scan: RunEventScan,
  options: { runId?: RunId; updatedAt?: string } = {},
): RunSummary {
  const first = scan.first;
  const metadata = first?.metadata;
  const terminal = scan.terminal;
  const started = scan.started;
  const lease = metadata?.browser_lease;
  const runtimeDenied = runtimePermissionDeniedSummary(
    scan.runtimePermissionDenied,
  );
  const summary: RunSummary = {
    run_id: options.runId ?? metadata?.run_id ?? first?.run_id ?? "unknown",
    command: metadata?.command,
    status: runStatus(scan.events, terminal),
    events: scan.events,
    ...(started ? { started_at: started.timestamp } : {}),
    ...(terminal ? { finished_at: terminal.timestamp } : {}),
    ...(options.updatedAt ? { updated_at: options.updatedAt } : {}),
    ...(metadata?.transport_surface
      ? { transport_surface: metadata.transport_surface }
      : {}),
    ...(metadata?.target_surface
      ? { target_surface: String(metadata.target_surface) }
      : {}),
    ...(runtimeDenied ? { runtime_permission_denied: runtimeDenied } : {}),
    ...browserLeaseSummary(lease),
  };
  const durationMs = runDurationMs(summary.started_at, summary.finished_at);
  return durationMs === undefined
    ? summary
    : { ...summary, duration_ms: durationMs };
}

function runtimePermissionDeniedSummary(
  event?: RunEvent,
): RunSummaryRuntimePermissionDenied | undefined {
  if (!event) return undefined;
  const code = stringDataField(event, "code");
  const action = stringDataField(event, "action");
  const step = numberDataField(event, "step");
  const ruleId = stringDataField(event, "rule_id");
  const resourceBuckets = stringArrayDataField(event, "resource_buckets");
  const retryable = booleanDataField(event, "retryable");
  const summary: RunSummaryRuntimePermissionDenied = {};
  let hasValue = false;

  if (code) {
    summary.code = code;
    hasValue = true;
  }
  if (action) {
    summary.action = action;
    hasValue = true;
  }
  if (step !== undefined) {
    summary.step = step;
    hasValue = true;
  }
  if (ruleId) {
    summary.rule_id = ruleId;
    hasValue = true;
  }
  if (resourceBuckets) {
    summary.resource_buckets = resourceBuckets;
    hasValue = true;
  }
  if (retryable !== undefined) {
    summary.retryable = retryable;
    hasValue = true;
  }

  return hasValue ? summary : undefined;
}

function stringDataField(event: RunEvent, field: string): string | undefined {
  const value = event.data?.[field];
  return typeof value === "string" ? value : undefined;
}

function numberDataField(event: RunEvent, field: string): number | undefined {
  const value = event.data?.[field];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanDataField(event: RunEvent, field: string): boolean | undefined {
  const value = event.data?.[field];
  return typeof value === "boolean" ? value : undefined;
}

function stringArrayDataField(
  event: RunEvent,
  field: string,
): string[] | undefined {
  const value = event.data?.[field];
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((entry): entry is string => {
    return typeof entry === "string";
  });
  return values.length > 0 ? values : undefined;
}

export function projectRunEvents(
  events: RunEvent[],
  options: { includeInternal?: boolean } = {},
): PublicRunEvent[] {
  return events.map((event) => {
    const { internal, secret: _secret, ...publicEvent } = event;
    if (!options.includeInternal || internal === undefined) {
      return publicEvent;
    }
    return { ...publicEvent, internal } as PublicRunEvent;
  });
}

function runStatus(eventCount: number, terminal?: RunEvent): RunTraceStatus {
  if (eventCount === 0) return "empty";
  if (terminal?.name === "run.completed") return "completed";
  if (terminal?.name === "run.failed") return "failed";
  return "running";
}

function browserLeaseSummary(lease?: BrowserSessionLease): Partial<RunSummary> {
  if (!lease) return {};
  return {
    browser_session_id: lease.browser_session_id,
    browser_workspace_id: lease.browser_workspace_id,
    ...(lease.target
      ? {
          browser_target_kind: lease.target.kind,
          ...(lease.target.target_id
            ? { browser_target_id: lease.target.target_id }
            : {}),
          ...(typeof lease.target.tab_id === "number"
            ? { browser_tab_id: lease.target.tab_id }
            : {}),
          ...(typeof lease.target.window_id === "number"
            ? { browser_window_id: lease.target.window_id }
            : {}),
        }
      : {}),
    ...(lease.auth
      ? {
          browser_auth_state: lease.auth.state,
          ...(typeof lease.auth.cookie_count === "number"
            ? { browser_cookie_count: lease.auth.cookie_count }
            : {}),
        }
      : {}),
    lease_owner: lease.lease_owner,
    lease_scope: lease.scope,
  };
}

function runDurationMs(
  started?: string,
  finished?: string,
): number | undefined {
  if (!started || !finished) return undefined;
  const startMs = Date.parse(started);
  const finishMs = Date.parse(finished);
  if (!Number.isFinite(startMs) || !Number.isFinite(finishMs)) {
    return undefined;
  }
  return Math.max(0, finishMs - startMs);
}
