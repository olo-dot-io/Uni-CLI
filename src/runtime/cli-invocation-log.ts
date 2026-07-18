/**
 * @owner       src::runtime::cli-invocation-log
 * @does        Correlates one CLI process, its nested kernel calls, rendered envelopes, and its terminal invocation event.
 * @needs       local event store, formatter observations, process exit semantics
 * @feeds       default local diagnostic log for core, fast-path, and adapter CLI calls
 * @breaks      Capturing raw argv leaks user input; missing exit finalization leaves core commands invisible.
 * @invariants  Raw arguments are never persisted; every child can reference one process invocation ID; one local-log failure is surfaced once.
 * @side-effects Registers exit and uncaught-exception monitor hooks and appends one event per non-metadata CLI process.
 * @perf        Constant in argv length with one append at process exit.
 * @concurrency One active CLI invocation per Node process.
 * @test        tests/unit/cli-invocation-log.test.ts and tests/unit/output/formatter.test.ts
 * @stability   internal
 * @since       2026-07-18
 */

import { randomUUID } from "node:crypto";
import type { AgentContext } from "../output/envelope.js";
import {
  appendLocalEvent,
  createLocalEvent,
  isLocalLoggingEnabled,
  localEventWarning,
} from "./local-event-log.js";

interface ActiveCliInvocation {
  invocationId: string;
  startedAt: number;
  command: string;
  targetSurface?: string;
  traceId?: string;
  outputBytes: number;
  errorType?: string;
  retryable?: boolean;
  errorStep?: number;
  outcomeAmbiguous?: boolean;
  targetUnusable?: boolean;
  observedLocalLogWarnings: Set<string>;
}

export interface BeginCliInvocationOptions {
  argv?: string[];
  startedAt?: number;
  registerProcessHooks?: boolean;
}

let activeInvocation: ActiveCliInvocation | undefined;
let processHooksRegistered = false;

export function beginCliInvocationLogging(
  options: BeginCliInvocationOptions = {},
): void {
  if (activeInvocation || !isLocalLoggingEnabled()) return;
  activeInvocation = {
    invocationId: randomUUID(),
    startedAt: options.startedAt ?? Date.now(),
    command: "core.unknown",
    outputBytes: 0,
    observedLocalLogWarnings: new Set(),
  };
  if (options.registerProcessHooks !== false) registerProcessHooks();
}

export function observeCliOutput(ctx: AgentContext, outputBytes: number): void {
  if (!activeInvocation) return;
  if (/^[a-z0-9_-]+\.[a-z0-9_-]+$/i.test(ctx.command)) {
    activeInvocation.command = ctx.command;
  }
  if (ctx.surface) activeInvocation.targetSurface = ctx.surface;
  activeInvocation.outputBytes += Math.max(0, outputBytes);
  if (!ctx.error) return;
  activeInvocation.errorType = ctx.error.code;
  activeInvocation.retryable = ctx.error.retryable ?? false;
  activeInvocation.errorStep = ctx.error.step;
  activeInvocation.outcomeAmbiguous = ctx.error.outcome_ambiguous;
  activeInvocation.targetUnusable = ctx.error.target_unusable;
}

export function observeCliTrace(traceId: string): void {
  if (!activeInvocation) return;
  activeInvocation.traceId = traceId;
}

export function currentCliInvocationId(): string | undefined {
  return activeInvocation?.invocationId;
}

export function observeCliLocalLogWarning(warning: string): void {
  activeInvocation?.observedLocalLogWarnings.add(warning);
}

export function observeCliInternalFailure(): void {
  if (!activeInvocation) return;
  activeInvocation.errorType = "internal_error";
  activeInvocation.retryable = false;
}

export function completeCliInvocation(exitCode: number): string | undefined {
  const invocation = activeInvocation;
  activeInvocation = undefined;
  if (!invocation) return undefined;
  const outcome =
    exitCode === 0 ? "success" : exitCode === 66 ? "empty" : "error";
  const warning = localEventWarning(
    appendLocalEvent(
      createLocalEvent({
        event_name: "unicli.cli.invocation.completed",
        invocation_id: invocation.invocationId,
        ...(invocation.traceId ? { trace_id: invocation.traceId } : {}),
        transport: "cli",
        command: invocation.command,
        operation_role: "invocation",
        ...(invocation.targetSurface
          ? { target_surface: invocation.targetSurface }
          : {}),
        outcome,
        exit_code: exitCode,
        duration_ms: Math.max(0, Date.now() - invocation.startedAt),
        ...(invocation.outputBytes > 0
          ? { result_bytes: invocation.outputBytes }
          : {}),
        ...(invocation.errorType
          ? {
              error_type: invocation.errorType,
              retryable: invocation.retryable ?? false,
              ...(invocation.errorStep !== undefined
                ? { error_step: invocation.errorStep }
                : {}),
              ...(invocation.outcomeAmbiguous
                ? { outcome_ambiguous: true }
                : {}),
              ...(invocation.targetUnusable ? { target_unusable: true } : {}),
            }
          : {}),
      }),
    ),
  );
  return warning && !invocation.observedLocalLogWarnings.has(warning)
    ? warning
    : undefined;
}

export function _resetCliInvocationLogForTests(): void {
  activeInvocation = undefined;
}

function registerProcessHooks(): void {
  if (processHooksRegistered) return;
  processHooksRegistered = true;
  process.once("uncaughtExceptionMonitor", observeCliInternalFailure);
  process.once("exit", (code) => {
    const warning = completeCliInvocation(code);
    if (warning) process.stderr.write(`${warning}\n`);
  });
}
