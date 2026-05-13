/**
 * @owner Uni-CLI Kernel
 * @does Builds invocations and runs the shared kernel stage chain.
 * @needs Registry resolution, compiled command cache, and explicit kernel stages.
 * @feeds CLI/MCP/ACP transport renderers through InvocationResult.
 * @breaks Surface parity when wrappers rebuild validation, authorization, execution, diagnostics, or envelopes.
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
import type { Invocation, InvocationResult } from "./types.js";
import { newULID } from "./ulid.js";

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
  } = {},
): Invocation | null {
  const resolved = resolveCommand(site, cmd);
  if (!resolved) return null;
  return {
    adapter: resolved.adapter,
    command: resolved.command,
    cmdName: cmd,
    bag,
    surface,
    permissionProfile: options.permissionProfile,
    approved: options.approved,
    rememberApproval: options.rememberApproval,
    trace_id: newULID(),
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

  await rememberKernelApproval(inv, authorization.policy, warnings);

  try {
    if (!inv.command.pipeline && !inv.command.func) {
      return malformedCommandResult(inv, ctx, startedAt, warnings).result;
    }
    const results = await executeKernelCommand(inv, ctx);
    return successKernelResult(inv, ctx, startedAt, warnings, results);
  } catch (err) {
    return executionErrorResult(inv, ctx, startedAt, warnings, err).result;
  }
}
