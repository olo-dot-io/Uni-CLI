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
  return summarizeRunEventScan(
    {
      first: events[0],
      started: events.find((event) => event.name === "run.started"),
      terminal: [...events]
        .reverse()
        .find(
          (event) =>
            event.name === "run.completed" || event.name === "run.failed",
        ),
      events: events.length,
    },
    options,
  );
}

interface RunEventScan {
  first?: RunEvent;
  started?: RunEvent;
  terminal?: RunEvent;
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
