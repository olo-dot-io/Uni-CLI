import {
  mkdir,
  readFile,
  appendFile,
  chmod,
  open,
  stat,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
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

interface RunEventTailState {
  offset: number;
  partialLine: string;
  nextLineNumber: number;
  decoder: StringDecoder;
}

interface ReadAppendedRunEventsResult {
  events: RunEvent[];
  sawTerminal: boolean;
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

  if (!follow) {
    const events = await readRunEvents(store, runId);
    const nextEvents = events
      .filter((event) => event.sequence > afterSequence)
      .sort((a, b) => a.sequence - b.sequence);
    for (const event of nextEvents) {
      yield event;
    }
    return;
  }

  const path = runTracePath(store, runId);
  const tailState: RunEventTailState = {
    offset: 0,
    partialLine: "",
    nextLineNumber: 1,
    decoder: new StringDecoder("utf8"),
  };

  while (true) {
    const readResult = await readAppendedRunEvents(path, tailState);
    const nextEvents = readResult.events
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

    if (yieldedTerminal || readResult.sawTerminal) return;
    if (deadline !== undefined && Date.now() >= deadline) return;

    const waitMs =
      deadline === undefined
        ? pollIntervalMs
        : Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()));
    if (waitMs <= 0) return;
    await delay(waitMs);
  }
}

async function readAppendedRunEvents(
  path: string,
  state: RunEventTailState,
): Promise<ReadAppendedRunEventsResult> {
  const size = await traceFileSize(path);
  if (size === undefined) return { events: [], sawTerminal: false };

  if (size < state.offset) {
    state.offset = 0;
    state.partialLine = "";
    state.nextLineNumber = 1;
    state.decoder = new StringDecoder("utf8");
  }
  if (size === state.offset) return { events: [], sawTerminal: false };

  const chunk = await readTraceChunk(path, state.offset, size - state.offset);
  state.offset += chunk.byteLength;

  const text = state.partialLine + state.decoder.write(chunk);
  const lastNewlineIndex = text.lastIndexOf("\n");
  if (lastNewlineIndex < 0) {
    state.partialLine = text;
    return { events: [], sawTerminal: false };
  }

  const completeText = text.slice(0, lastNewlineIndex + 1);
  state.partialLine = text.slice(lastNewlineIndex + 1);
  const lines = completeText.split(/\r?\n/);
  const events: RunEvent[] = [];
  let sawTerminal = false;

  for (let index = 0; index < lines.length - 1; index += 1) {
    const lineText = lines[index] ?? "";
    const lineNumber = state.nextLineNumber;
    state.nextLineNumber += 1;
    if (lineText.trim().length === 0) continue;
    try {
      const event = JSON.parse(lineText) as RunEvent;
      if (isTerminalRunEvent(event)) sawTerminal = true;
      events.push(event);
    } catch {
      throw new RunStoreError(
        "malformed_jsonl",
        `malformed run trace JSONL at line ${lineNumber}`,
        path,
        lineNumber,
      );
    }
  }

  return { events, sawTerminal };
}

async function traceFileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch (err) {
    if (errorCode(err) === "ENOENT") return undefined;
    const message = err instanceof Error ? err.message : String(err);
    throw new RunStoreError(
      "io_error",
      `failed to stat run events: ${message}`,
      path,
    );
  }
}

async function readTraceChunk(
  path: string,
  offset: number,
  byteLength: number,
): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(byteLength);
    const { bytesRead } = await handle.read(buffer, 0, byteLength, offset);
    return buffer.subarray(0, bytesRead);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return Buffer.alloc(0);
    const message = err instanceof Error ? err.message : String(err);
    throw new RunStoreError(
      "io_error",
      `failed to read run event tail: ${message}`,
      path,
    );
  } finally {
    await handle?.close();
  }
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

function isTerminalRunEvent(event: RunEvent): boolean {
  return event.name === "run.completed" || event.name === "run.failed";
}
