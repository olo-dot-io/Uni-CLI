/**
 * @owner       src::runtime::cli-invocation-log
 * @does        Correlates one CLI process with rendered envelopes and persists its terminal invocation event.
 * @needs       local event store, formatter observations, process exit semantics
 * @feeds       default local diagnostic log for core, fast-path, and adapter CLI calls
 * @breaks      Capturing raw argv leaks user input; missing exit finalization leaves core commands invisible.
 * @invariants  Raw arguments are never persisted; the exit hook performs only synchronous local I/O and never changes the command exit code.
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
  const argv = options.argv ?? process.argv;
  activeInvocation = {
    invocationId: randomUUID(),
    startedAt: options.startedAt ?? Date.now(),
    command: fallbackCommand(argv.slice(2)),
    outputBytes: 0,
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
  return localEventWarning(
    appendLocalEvent(
      createLocalEvent({
        event_name: "unicli.cli.invocation.completed",
        invocation_id: invocation.invocationId,
        ...(invocation.traceId ? { trace_id: invocation.traceId } : {}),
        transport: "cli",
        command: invocation.command,
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

function fallbackCommand(args: string[]): string {
  const token = firstCommandToken(args);
  return token && /^[a-z0-9_-]+$/i.test(token)
    ? `core.${token.toLowerCase()}`
    : "core.unknown";
}

function firstCommandToken(args: string[]): string | undefined {
  const optionsWithValues = new Set([
    "-f",
    "--format",
    "--args-file",
    "--permission-profile",
    "--select",
    "--fields",
    "--pluck",
    "--pluck0",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (optionsWithValues.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("--") && token.includes("=")) continue;
    if (token.startsWith("-")) continue;
    return token;
  }
  return undefined;
}
