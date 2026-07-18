/**
 * @owner       src::engine::kernel::execute
 * @does        Builds invocations, runs the shared stage chain, and emits privacy-safe terminal tool-call diagnostics.
 * @needs       registry resolution, compiled command cache, explicit kernel stages, CLI parent correlation, local event log
 * @feeds       CLI/MCP/ACP/bench/hub transport renderers through InvocationResult and local usage projection
 * @breaks      Surface parity when wrappers rebuild validation, authorization, execution, diagnostics, envelopes, or tool-call observation.
 * @invariants  Cancellation is checked before dispatch; authorized effect determines outcome ambiguity; log failure warns but never replaces a settled operation result.
 * @side-effects Executes adapter operations and appends one allowlisted local event unless explicitly disabled.
 * @perf        One bounded local append after each completed invocation.
 * @concurrency Invocation trace IDs isolate calls; the event store owns concurrent append semantics.
 * @test        tests/unit/engine/invoke.test.ts and tests/unit/kernel-stage-parity.test.ts
 * @stability   stable
 * @since       2026-04-17
 */

import { resolveCommand } from "../../registry.js";
import type { ResolvedArgs } from "../args.js";
import {
  authorizeKernelInvocation,
  executeKernelCommand,
  executionErrorResult,
  hardenKernelInput,
  malformedCommandResult,
  rememberKernelApproval,
  resolveKernelCommandContext,
  successKernelResult,
  validateKernelInput,
} from "./stages.js";
import { KernelLookupError } from "./errors.js";
import type {
  Invocation,
  InvocationDiagnosticIdentity,
  InvocationResult,
} from "./types.js";
import { newULID } from "./ulid.js";
import {
  appendLocalEvent,
  createLocalEvent,
  isLocalLoggingEnabled,
  localEventWarning,
} from "../../runtime/local-event-log.js";
import type { KernelCommandContext } from "./stages.js";
import {
  currentCliInvocationId,
  observeCliLocalLogWarning,
  observeCliTrace,
} from "../../runtime/cli-invocation-log.js";

export { KernelLookupError };

/**
 * Look up an adapter + command pair and return an Invocation ready for
 * execute(). Returns `null` if either the site or command is unknown —
 * callers can emit their own "unknown command" envelope.
 */
export function buildInvocation(
  surface: Invocation["surface"],
  site: string,
  cmd: string,
  bag: ResolvedArgs,
  options: {
    permissionProfile?: string;
    approved?: boolean;
    rememberApproval?: boolean;
    signal?: AbortSignal;
    parentInvocationId?: string;
    operationRole?: "direct" | "nested";
  } = {},
): Invocation | null {
  const resolved = resolveCommand(site, cmd);
  if (!resolved) return null;
  const diagnosticParentInvocationId =
    options.parentInvocationId ??
    (surface === "cli" ? currentCliInvocationId() : undefined);
  const diagnosticIdentity: InvocationDiagnosticIdentity =
    diagnosticParentInvocationId
      ? {
          diagnosticParentInvocationId,
          diagnosticRole: options.operationRole ?? "nested",
        }
      : { diagnosticRole: "standalone" };
  return {
    adapter: resolved.adapter,
    command: resolved.command,
    cmdName: cmd,
    bag,
    surface,
    permissionProfile: options.permissionProfile,
    approved: options.approved,
    rememberApproval: options.rememberApproval,
    signal: options.signal,
    trace_id: newULID(),
    ...diagnosticIdentity,
  };
}

/**
 * Run a validated, hardened invocation end-to-end. Failure paths never
 * throw — every error surfaces as `{ exitCode, error }` on the returned
 * result so transport code can do uniform error handling.
 */
export async function execute(inv: Invocation): Promise<InvocationResult> {
  const startedAt = Date.now();
  const warnings: string[] = [];
  const ctx = resolveKernelCommandContext(inv);
  if (inv.surface === "cli") observeCliTrace(inv.trace_id);

  const result = await executeResolved(inv, ctx, startedAt, warnings);
  if (!isLocalLoggingEnabled()) return result;
  const resultBytes = serializedResultBytes(result.results);
  const warning = localEventWarning(
    appendLocalEvent(
      createLocalEvent({
        event_name: "unicli.tool.call.completed",
        invocation_id: inv.trace_id,
        ...(inv.diagnosticParentInvocationId
          ? { parent_invocation_id: inv.diagnosticParentInvocationId }
          : {}),
        trace_id: inv.trace_id,
        transport: inv.surface,
        command: ctx.key,
        site: inv.adapter.name,
        cmd: inv.cmdName,
        strategy: ctx.strategy ?? "unknown",
        target_surface: ctx.targetSurface,
        operation_role: inv.diagnosticRole,
        outcome:
          result.error !== undefined
            ? "error"
            : result.results.length === 0
              ? "empty"
              : "success",
        exit_code: result.exitCode,
        duration_ms: result.durationMs,
        result_count: result.results.length,
        ...(resultBytes !== undefined ? { result_bytes: resultBytes } : {}),
        ...(result.error
          ? {
              error_type: result.error.code,
              retryable: result.error.retryable ?? false,
              ...(result.error.step !== undefined
                ? { error_step: result.error.step }
                : {}),
              ...(result.error.outcome_ambiguous
                ? { outcome_ambiguous: true }
                : {}),
              ...(result.error.target_unusable
                ? { target_unusable: true }
                : {}),
            }
          : {}),
      }),
    ),
  );
  if (warning) {
    if (inv.surface === "cli") observeCliLocalLogWarning(warning);
    result.warnings.push(warning);
  }
  return result;
}

async function executeResolved(
  inv: Invocation,
  ctx: KernelCommandContext,
  startedAt: number,
  warnings: string[],
): Promise<InvocationResult> {
  if (inv.signal?.aborted) {
    return executionErrorResult(
      inv,
      ctx,
      startedAt,
      warnings,
      inv.signal.reason,
    ).result;
  }

  const invalid = validateKernelInput(inv, ctx, startedAt, warnings);
  if (invalid) return invalid.result;

  const hardened = hardenKernelInput(inv, ctx, startedAt, warnings);
  if (hardened) return hardened.result;

  const authorization = await authorizeKernelInvocation(
    inv,
    ctx,
    startedAt,
    warnings,
  );
  if (authorization.blocked) return authorization.blocked.result;

  if (inv.signal?.aborted) {
    return executionErrorResult(
      inv,
      ctx,
      startedAt,
      warnings,
      inv.signal.reason,
    ).result;
  }

  await rememberKernelApproval(inv, authorization.policy, warnings);

  try {
    inv.signal?.throwIfAborted();
    if (!inv.command.pipeline && !inv.command.func) {
      return malformedCommandResult(inv, ctx, startedAt, warnings).result;
    }
    const results = await executeKernelCommand(
      inv,
      ctx,
      authorization.policy.effect !== "read",
    );
    return successKernelResult(inv, ctx, startedAt, warnings, results);
  } catch (err) {
    return executionErrorResult(inv, ctx, startedAt, warnings, err).result;
  }
}

function serializedResultBytes(results: unknown[]): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(results), "utf-8");
  } catch {
    return undefined;
  }
}
