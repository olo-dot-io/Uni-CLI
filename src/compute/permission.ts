/**
 * @owner       src::compute::permission
 * @does        Authorize direct CLI and MCP computer-use commands against the shared semantic policy and approval runtime.
 * @needs       compute contracts, operation policy runtime, approval store, structured transport envelopes
 * @feeds       src/commands/compute.ts, src/mcp/profiles/computer-use.ts
 * @breaks      Any bypass here lets direct computer control escape adapter-kernel permission policy.
 * @invariants  Authorization completes before bus, overlay, file, clipboard, app, or browser side effects; policy constraints see canonical contract arguments.
 * @side-effects Reads policy/approval files and optionally persists an explicitly requested CLI approval.
 * @perf        One contract lookup plus shared permission evaluation per computer-use call.
 * @concurrency Durable approvals use the shared append-only store; argument normalization is pure.
 * @test        tests/unit/compute-permission.test.ts, tests/unit/commands/compute.test.ts, tests/unit/mcp/tools.test.ts
 * @stability   stable
 * @since       2026-07-15
 */

import { err } from "../core/envelope.js";
import {
  createApprovalStore,
  rememberApproval,
} from "../engine/approval-store.js";
import {
  InvalidPermissionProfileError,
  type OperationEffect,
  type OperationPolicy,
} from "../engine/operation-policy.js";
import { evaluateOperationPolicyWithApprovals } from "../engine/permission-runtime.js";
import { PermissionRulesConfigError } from "../engine/permission-rules.js";
import type { ActionResult } from "../transport/types.js";
import { AdapterType } from "../types.js";
import {
  getComputeCommandContract,
  type ComputeCommandContract,
} from "./contracts.js";

export interface ComputePermissionOptions {
  profile?: string;
  approved?: boolean;
  rememberApproval?: boolean;
}

export type ComputeAuthorizationResult =
  | { ok: true; policy: OperationPolicy }
  | { ok: false; result: ActionResult<never> };

export async function authorizeComputeOperation(
  command: string,
  argumentValues: Record<string, unknown>,
  options: ComputePermissionOptions = {},
): Promise<ComputeAuthorizationResult> {
  const contract = getComputeCommandContract(command);
  if (!contract) {
    return {
      ok: false,
      result: permissionFailure(
        command,
        `unknown compute permission contract: ${command}`,
        "repair the compute command registry before retrying",
        "permission.config",
        78,
      ),
    };
  }

  const canonicalArguments = canonicalPermissionArguments(
    command,
    argumentValues,
  );
  try {
    const policy = await evaluateOperationPolicyWithApprovals({
      site: "compute",
      command,
      description: contract.description,
      adapterType: AdapterType.DESKTOP,
      targetSurface: "desktop",
      args: contract.args.map((arg) => ({
        name: arg.name,
        required: arg.required,
      })),
      capabilities: [`compute.${contract.kind}`],
      minimumCapability: `compute.${contract.command}`,
      profile: options.profile,
      approved: options.approved,
      effect: computeOperationEffect(contract, canonicalArguments),
      argumentValues: canonicalArguments,
    });

    if (policy.enforcement === "deny") {
      const ruleId = policy.deny_rule?.id ?? "unknown";
      const reason = policy.deny_rule?.reason ?? policy.reason;
      return {
        ok: false,
        result: permissionFailure(
          command,
          `permission rule "${ruleId}" denies ${policy.effect}: ${reason}`,
          policy.approval_hint ?? "edit or remove the matching permission rule",
          "permission.denied",
          77,
        ),
      };
    }
    if (policy.enforcement === "needs_approval") {
      return {
        ok: false,
        result: permissionFailure(
          command,
          `permission profile "${policy.profile}" requires approval for ${policy.effect}`,
          policy.approval_hint ??
            "rerun with --yes or use --permission-profile open",
          "permission.denied",
          77,
        ),
      };
    }

    if (options.rememberApproval === true) {
      try {
        await rememberApproval(createApprovalStore(), { policy });
      } catch (error) {
        return {
          ok: false,
          result: permissionFailure(
            command,
            `failed to persist approval memory: ${errorMessage(error)}`,
            "repair ~/.unicli permissions or omit --remember-approval",
            "permission.config",
            78,
          ),
        };
      }
    }

    return { ok: true, policy };
  } catch (error) {
    if (
      error instanceof InvalidPermissionProfileError ||
      error instanceof PermissionRulesConfigError
    ) {
      return {
        ok: false,
        result: permissionFailure(
          command,
          error.message,
          error instanceof PermissionRulesConfigError
            ? error.suggestion
            : "use one of: open, confirm, locked",
          "permission.config",
          2,
        ),
      };
    }
    throw error;
  }
}

export function canonicalPermissionArguments(
  command: string,
  argumentValues: Record<string, unknown>,
): Record<string, unknown> {
  if (command === "eval" && argumentValues.js === undefined) {
    return {
      ...argumentValues,
      ...(argumentValues.script !== undefined
        ? { js: argumentValues.script }
        : {}),
    };
  }
  if (command === "wait" && argumentValues.timeoutMs === undefined) {
    return {
      ...argumentValues,
      ...(argumentValues.timeout !== undefined
        ? { timeoutMs: argumentValues.timeout }
        : {}),
    };
  }
  return argumentValues;
}

export function computeOperationEffect(
  contract: ComputeCommandContract,
  arguments_: Record<string, unknown>,
): OperationEffect {
  if (contract.command === "screenshot") {
    return nonEmptyString(arguments_.path) ? "local_file" : "read";
  }
  if (contract.command === "capture") {
    return nonEmptyString(arguments_.screenshotPath) ||
      nonEmptyString(arguments_.referenceRoot) ||
      arguments_.saveReference === true ||
      arguments_.copyReference === true
      ? "local_file"
      : "read";
  }
  return contract.readOnly === true ? "read" : "local_app";
}

function permissionFailure(
  command: string,
  reason: string,
  suggestion: string,
  minimumCapability: string,
  exitCode: number,
): ActionResult<never> {
  return err({
    transport: "subprocess",
    step: 0,
    action: `compute_${command}.authorize`,
    reason,
    suggestion,
    minimum_capability: minimumCapability,
    exit_code: exitCode,
  });
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
