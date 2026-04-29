import { mkdir, readFile, appendFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";
import { userHome } from "../user-home.js";
import type { RunEvent, RunId } from "./types.js";

export interface RunStore {
  rootDir: string;
}

export interface WatchRunEventsOptions {
  afterSequence?: number;
  follow?: boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export type RunStoreErrorCode =
  | "invalid_run_id"
  | "malformed_jsonl"
  | "io_error";

export class RunStoreError extends Error {
  constructor(
    public readonly code: RunStoreErrorCode,
    message: string,
    public readonly path?: string,
    public readonly line?: number,
  ) {
    super(message);
    this.name = "RunStoreError";
  }
}

export function createRunStore(
  options: {
    rootDir?: string;
    homeDir?: string;
  } = {},
): RunStore {
  const rootDir =
    options.rootDir ??
    (options.homeDir !== undefined
      ? join(options.homeDir, ".unicli", "runs")
      : (process.env.UNICLI_RUN_ROOT ?? join(userHome(), ".unicli", "runs")));
  return {
    rootDir,
  };
}

function assertRunId(runId: RunId): void {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new RunStoreError("invalid_run_id", `invalid run id: ${runId}`);
  }
}

export function runTracePath(store: RunStore, runId: RunId): string {
  assertRunId(runId);
  return join(store.rootDir, runId, "trace.jsonl");
}

export async function appendRunEvent(
  store: RunStore,
  event: RunEvent,
): Promise<void> {
  const path = runTracePath(store, event.run_id);
  const runDir = dirname(path);
  try {
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      await chmod(runDir, 0o700);
    }
    await appendFile(path, `${JSON.stringify(event)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    if (process.platform !== "win32") {
      await chmod(path, 0o600);
    }
  } catch (err) {
    if (err instanceof RunStoreError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new RunStoreError(
      "io_error",
      `failed to append run event: ${message}`,
      path,
    );
  }
}

export async function readRunEvents(
  store: RunStore,
  runId: RunId,
): Promise<RunEvent[]> {
  const path = runTracePath(store, runId);
  if (!existsSync(path)) return [];

  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RunStoreError(
      "io_error",
      `failed to read run events: ${message}`,
      path,
    );
  }

  const events: RunEvent[] = [];
  const lines = raw.split(/\r?\n/);
  lines.forEach((lineText, index) => {
    if (lineText.trim().length === 0) return;
    try {
      events.push(JSON.parse(lineText) as RunEvent);
    } catch {
      throw new RunStoreError(
        "malformed_jsonl",
        `malformed run trace JSONL at line ${index + 1}`,
        path,
        index + 1,
      );
    }
  });
  return events;
}

export async function* watchRunEvents(
  store: RunStore,
  runId: RunId,
  options: WatchRunEventsOptions = {},
): AsyncGenerator<RunEvent> {
  const follow = options.follow === true;
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 250);
  const timeoutMs = Math.max(0, options.timeoutMs ?? 30_000);
  const deadline = follow ? Date.now() + timeoutMs : undefined;
  let afterSequence = Math.max(0, Math.floor(options.afterSequence ?? 0));

  while (true) {
    const events = await readRunEvents(store, runId);
    const nextEvents = events
      .filter((event) => event.sequence > afterSequence)
      .sort((a, b) => a.sequence - b.sequence);
    let yieldedTerminal = false;

    for (const event of nextEvents) {
      yield event;
      afterSequence = Math.max(afterSequence, event.sequence);
      if (isTerminalRunEvent(event)) {
        yieldedTerminal = true;
      }
    }

    if (!follow || yieldedTerminal) return;
    if (events.some((event) => isTerminalRunEvent(event))) return;
    if (deadline !== undefined && Date.now() >= deadline) return;

    const waitMs =
      deadline === undefined
        ? pollIntervalMs
        : Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()));
    if (waitMs <= 0) return;
    await delay(waitMs);
  }
}

function isTerminalRunEvent(event: RunEvent): boolean {
  return event.name === "run.completed" || event.name === "run.failed";
}
