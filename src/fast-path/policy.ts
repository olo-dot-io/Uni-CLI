/**
 * Operation-policy gate evaluation for the fast path.
 *
 * Wraps `engine/operation-policy.ts` with the manifest-driven inputs needed
 * by `describe`, `--dry-run`, and pre-execution policy gates. On configuration
 * errors, prints a structured envelope and exits with USAGE_ERROR.
 */

import { existsSync, readFileSync } from "node:fs";
import {
  createApprovalStore,
  isStoredApproval,
} from "../engine/approval-store.js";
import {
  evaluateOperationPolicy,
  InvalidPermissionProfileError,
  type OperationPolicy,
} from "../engine/operation-policy.js";
import {
  applyDenyRuleToPolicy,
  findDenyRuleForPolicySync,
  PermissionRulesConfigError,
} from "../engine/permission-rules.js";
import { defaultErrorNextActions } from "../output/next-actions.js";
import { format, detectFormat } from "../output/formatter.js";
import { ExitCode, type TargetSurface } from "../types.js";
import type { ManifestCommand } from "./manifest.js";
import type { ParsedArgv } from "./parsed-argv.js";
import { type Io, emitStderrAndExit } from "./render.js";

export function hasStoredApproval(key: string): boolean {
  const store = createApprovalStore();
  if (!existsSync(store.path)) return false;
  try {
    const raw = readFileSync(store.path, "utf-8");
    const lines = raw.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line.trim().length === 0) continue;
      try {
        const entry = JSON.parse(line) as unknown;
        if (isStoredApproval(entry) && entry.key === key) {
          return entry.decision === "allow";
        }
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function evaluateManifestOperationPolicy(input: {
  parsed: ParsedArgv;
  io: Io;
  site: string;
  commandName: string;
  command: ManifestCommand;
  adapterType: string;
  targetSurface: TargetSurface;
  adapterPath: string;
  startedAt: number;
}): OperationPolicy | null {
  try {
    const policyInput = {
      site: input.site,
      command: input.commandName,
      description: input.command.description,
      adapterType: input.adapterType,
      targetSurface: input.targetSurface,
      strategy: input.command.strategy,
      domain: input.command.domain,
      base: input.command.base,
      browser: input.command.browser === true,
      args: input.command.args,
      profile: input.parsed.permissionProfile,
      approved: input.parsed.yes,
    };
    const policy = evaluateOperationPolicy(policyInput);
    const denyRule = findDenyRuleForPolicySync(policy);
    if (denyRule) return applyDenyRuleToPolicy(policy, denyRule);

    if (
      policy.enforcement === "needs_approval" &&
      hasStoredApproval(policy.approval_memory.key)
    ) {
      return evaluateOperationPolicy({
        ...policyInput,
        approvalSource: "memory",
      });
    }
    return policy;
  } catch (error) {
    if (
      !(
        error instanceof InvalidPermissionProfileError ||
        error instanceof PermissionRulesConfigError
      )
    ) {
      throw error;
    }

    emitStderrAndExit(
      input.io,
      format([], input.command.columns, detectFormat(input.parsed.format), {
        command: `${input.site}.${input.commandName}`,
        duration_ms: Date.now() - input.startedAt,
        surface: input.targetSurface,
        error: {
          code: "invalid_input",
          message: error.message,
          adapter_path: input.adapterPath,
          step: 0,
          suggestion:
            error instanceof PermissionRulesConfigError
              ? error.suggestion
              : "use one of: open, confirm, locked",
          retryable: false,
        },
        next_actions: defaultErrorNextActions(
          input.site,
          input.commandName,
          "invalid_input",
        ),
      }),
      ExitCode.USAGE_ERROR,
    );
    return null;
  }
}
