/**
 * @owner       src::transport::contained-process
 * @does        Run one native command through the platform process owner and await complete ownership termination before cancellation or timeout returns.
 * @needs       node child_process types and src/transport/process-owner.ts
 * @feeds       subprocess, macOS AX, and explicit CDP app launch transports
 * @breaks      Killing only the launcher PID lets same-group descendants mutate the host after an Agent turn has ended; arbitrary commands can still daemonize outside the group and must be classified ambiguous by callers.
 * @invariants  Every child has a saved POSIX process-group or Windows Job owner identity; abort and timeout await owner termination and stdio close; early stdin EPIPE defers to the authoritative child exit; both abort and timeout remain outcome-ambiguous for commands capable of external delivery.
 * @side-effects Spawns and terminates owned native process trees.
 * @perf        Buffers stdout/stderr once; cancellation adds at most the bounded termination interval.
 * @concurrency Every runner owns its listeners, timers, child, and process group; no request state is global.
 * @test        tests/unit/transport/contained-process.test.ts and compute cancellation blackboxes
 * @stability   stable
 * @since       2026-07-15
 */

import type { SpawnOwnedProcessOptions } from "./process-owner.js";
import { spawnOwnedProcess, terminateOwnedProcess } from "./process-owner.js";

export { terminateOwnedProcess as terminateProcessTree } from "./process-owner.js";

export type CancellationDelivery = "contained" | "outcome-ambiguous";

export interface ContainedProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  cancellationDelivery?: CancellationDelivery;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
}

export interface ContainedProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
}

export class OperationOutcomeAmbiguousError extends Error {
  readonly outcome_ambiguous = true;

  constructor(
    readonly operation: string,
    readonly cancellationReason: unknown,
  ) {
    super(
      `${operation} was cancelled after dispatch; its external outcome is ambiguous`,
      { cause: cancellationReason },
    );
    this.name = "OperationOutcomeAmbiguousError";
  }
}

export class ProcessContainmentAmbiguousError extends Error {
  readonly outcome_ambiguous = true;
  readonly retryable = false;
  readonly target_unusable = true;

  constructor(
    readonly operation: string,
    readonly cancellationReason: unknown,
    authoritativeError: unknown,
    containmentError: unknown,
  ) {
    super(
      `${operation} external outcome is ambiguous because its process tree could not be contained`,
      {
        cause: new AggregateError(
          [authoritativeError, containmentError],
          `${operation} failed and its process tree could not be contained`,
        ),
      },
    );
    this.name = "ProcessContainmentAmbiguousError";
  }
}

export type OutcomeAmbiguousError = Error & {
  readonly outcome_ambiguous: true;
  readonly operation?: string;
  readonly cancellationReason?: unknown;
  readonly retryable?: boolean;
  readonly target_unusable?: boolean;
};

class CancellationTrigger {
  constructor(readonly reason: unknown) {}
}

class TimeoutTrigger extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`${command} timed out after ${String(timeoutMs)}ms`);
    this.name = "TimeoutError";
  }
}

const PROCESS_CLOSE_GRACE_MS = 2_000;

export async function runContainedProcess(
  command: string,
  args: readonly string[],
  options: ContainedProcessOptions = {},
): Promise<ContainedProcessResult> {
  options.signal?.throwIfAborted();
  const child = spawnOwnedProcess(command, args, spawnOptions(options)).child;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk);
    options.onStdout?.(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
    options.onStderr?.(chunk);
  });
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const failed = new Promise<never>((_resolve, reject) => {
    child.once("error", reject);
    child.stdin?.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
  });
  let abortListener: (() => void) | undefined;
  const cancelled = options.signal
    ? new Promise<never>((_resolve, reject) => {
        abortListener = () =>
          reject(
            new CancellationTrigger(
              options.signal?.reason ??
                new DOMException("Native process aborted", "AbortError"),
            ),
          );
        options.signal?.addEventListener("abort", abortListener, {
          once: true,
        });
        if (options.signal?.aborted) abortListener();
      })
    : undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timedOut =
    options.timeoutMs === undefined
      ? undefined
      : new Promise<never>((_resolve, reject) => {
          timeoutTimer = setTimeout(
            () => reject(new TimeoutTrigger(command, options.timeoutMs!)),
            options.timeoutMs,
          );
        });

  child.stdin?.end(options.input);

  try {
    const completed = await Promise.race([
      closed,
      failed,
      ...(cancelled ? [cancelled] : []),
      ...(timedOut ? [timedOut] : []),
    ]);
    return {
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      exitCode: completed.code ?? (completed.signal ? 1 : 0),
      signal: completed.signal,
    };
  } catch (error) {
    const authoritativeError = authoritativeProcessError(
      command,
      error,
      options.cancellationDelivery,
    );
    if (child.pid !== undefined) {
      try {
        await terminateOwnedProcess(child);
        await waitForPromise(
          closed,
          PROCESS_CLOSE_GRACE_MS,
          `native process ${String(child.pid)} did not close stdio after its process tree exited`,
        );
      } catch (containmentError) {
        throw new ProcessContainmentAmbiguousError(
          command,
          cancellationReason(authoritativeError),
          authoritativeError,
          containmentError,
        );
      }
    }
    throw authoritativeError;
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (options.signal && abortListener) {
      options.signal.removeEventListener("abort", abortListener);
    }
  }
}

export function isOperationOutcomeAmbiguousError(error: unknown): boolean {
  return findOperationOutcomeAmbiguousError(error) !== undefined;
}

export function findOperationOutcomeAmbiguousError(
  error: unknown,
): OutcomeAmbiguousError | undefined {
  return findOutcomeAmbiguity(error, new Set<object>());
}

function authoritativeProcessError(
  command: string,
  error: unknown,
  cancellationDelivery: CancellationDelivery | undefined,
): unknown {
  if (error instanceof CancellationTrigger) {
    return cancellationDelivery === "outcome-ambiguous"
      ? new OperationOutcomeAmbiguousError(command, error.reason)
      : error.reason;
  }
  if (
    error instanceof TimeoutTrigger &&
    cancellationDelivery === "outcome-ambiguous"
  ) {
    return new OperationOutcomeAmbiguousError(command, error);
  }
  return error;
}

function cancellationReason(error: unknown): unknown {
  const ambiguity = findOperationOutcomeAmbiguousError(error);
  return ambiguity?.cancellationReason ?? error;
}

function findOutcomeAmbiguity(
  value: unknown,
  visited: Set<object>,
): OutcomeAmbiguousError | undefined {
  if (!(value instanceof Error) || visited.has(value)) return undefined;
  visited.add(value);
  if (
    "outcome_ambiguous" in value &&
    (value as { outcome_ambiguous?: unknown }).outcome_ambiguous === true
  ) {
    return value as OutcomeAmbiguousError;
  }
  if (value instanceof AggregateError) {
    for (const nested of value.errors) {
      const ambiguity = findOutcomeAmbiguity(nested, visited);
      if (ambiguity) return ambiguity;
    }
  }
  return findOutcomeAmbiguity(value.cause, visited);
}

function spawnOptions(
  options: ContainedProcessOptions,
): SpawnOwnedProcessOptions {
  return {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
    stdio: ["pipe", "pipe", "pipe"],
  };
}

async function waitForPromise<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
