import { readdir, stat } from "node:fs/promises";
import type { BrowserSessionLease } from "../browser/session-lease.js";
import {
  readRunEvents,
  runTracePath,
  type RunStore,
  RunStoreError,
} from "./store.js";
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
  lease_owner?: string;
  lease_scope?: string;
  error_code?: string;
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
  const tracePath = runTracePath(store, runId);
  const traceStat = await stat(tracePath).catch(() => null);
  if (!traceStat) return null;

  try {
    const events = await readRunEvents(store, runId);
    return summarizeRunEvents(events, {
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
  const first = events[0];
  const metadata = first?.metadata;
  const terminal = [...events]
    .reverse()
    .find(
      (event) => event.name === "run.completed" || event.name === "run.failed",
    );
  const started = events.find((event) => event.name === "run.started");
  const lease = metadata?.browser_lease;
  const summary: RunSummary = {
    run_id: options.runId ?? metadata?.run_id ?? first?.run_id ?? "unknown",
    command: metadata?.command,
    status: runStatus(events, terminal),
    events: events.length,
    ...(started ? { started_at: started.timestamp } : {}),
    ...(terminal ? { finished_at: terminal.timestamp } : {}),
    ...(options.updatedAt ? { updated_at: options.updatedAt } : {}),
    ...(metadata?.transport_surface
      ? { transport_surface: metadata.transport_surface }
      : {}),
    ...(metadata?.target_surface
      ? { target_surface: String(metadata.target_surface) }
      : {}),
    ...browserLeaseSummary(lease),
  };
  const durationMs = runDurationMs(summary.started_at, summary.finished_at);
  return durationMs === undefined
    ? summary
    : { ...summary, duration_ms: durationMs };
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

function runStatus(events: RunEvent[], terminal?: RunEvent): RunTraceStatus {
  if (events.length === 0) return "empty";
  if (terminal?.name === "run.completed") return "completed";
  if (terminal?.name === "run.failed") return "failed";
  return "running";
}

function browserLeaseSummary(lease?: BrowserSessionLease): Partial<RunSummary> {
  if (!lease) return {};
  return {
    browser_session_id: lease.browser_session_id,
    browser_workspace_id: lease.browser_workspace_id,
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
