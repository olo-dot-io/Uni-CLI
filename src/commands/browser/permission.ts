/**
 * @owner       src::commands::browser::permission
 * @does        Authorize direct browser/operate CLI commands with semantic effects, actual arguments, deny-first rules, and approval memory.
 * @needs       operation permission runtime, approval store, browser action vocabulary, Commander root options
 * @feeds       Browser operator, lifecycle, profile, cookie, native-host, and adapter-generation/authoring command handlers
 * @breaks      Any direct browser command executed before this boundary can bypass the shared permission policy.
 * @invariants  Authorization completes before invocation scope or broker acquisition; explicit denials outrank profile and remembered approvals.
 * @side-effects Reads policy/approval files and optionally persists an explicitly requested approval.
 * @perf        One permission evaluation per top-level browser operator command.
 * @concurrency Permission files use stable reads and approval memory uses the shared append-only store.
 * @test        tests/unit/commands/browser.test.ts, tests/unit/permission-rules.test.ts
 * @stability   stable
 * @since       2026-07-15
 */

import {
  createApprovalStore,
  rememberApproval,
} from "../../engine/approval-store.js";
import type { Command } from "commander";
import {
  InvalidPermissionProfileError,
  type OperationEffect,
  type OperationPolicy,
} from "../../engine/operation-policy.js";
import { evaluateOperationPolicyWithApprovals } from "../../engine/permission-runtime.js";
import { PermissionRulesConfigError } from "../../engine/permission-rules.js";
import { AdapterType, Strategy } from "../../types.js";

export interface BrowserOperatorPermissionOptions {
  profile?: string;
  approved?: boolean;
  rememberApproval?: boolean;
  argumentValues?: Record<string, unknown>;
}

export class BrowserOperatorPermissionError extends Error {
  readonly code: "permission_denied" | "invalid_input";
  readonly suggestion: string;
  readonly exitCode: number;

  constructor(input: {
    message: string;
    code: "permission_denied" | "invalid_input";
    suggestion: string;
    exitCode: number;
  }) {
    super(input.message);
    this.name = "BrowserOperatorPermissionError";
    this.code = input.code;
    this.suggestion = input.suggestion;
    this.exitCode = input.exitCode;
  }
}

const READ_ACTIONS = new Set([
  "cdp",
  "console",
  "dialogs",
  "downloads",
  "frames",
  "get_attributes",
  "get_html",
  "get_text",
  "get_title",
  "get_url",
  "get_value",
  "query",
  "remote",
  "search",
  "sessions",
  "state",
  "status",
  "tabs",
  "wait",
  "broker_status",
  "native_host_extension_path",
  "native_host_status",
  "profiles",
  "verify",
]);

export async function authorizeBrowserCommand(
  program: Command,
  namespace: string,
  action: string,
  argumentValues: Record<string, unknown> = {},
): Promise<OperationPolicy> {
  const options = program.opts() as {
    permissionProfile?: string;
    yes?: boolean;
    rememberApproval?: boolean;
  };
  return authorizeBrowserOperator(namespace, action, {
    profile: options.permissionProfile,
    approved: options.yes === true,
    rememberApproval: options.rememberApproval === true,
    argumentValues,
  });
}

export async function authorizeBrowserOperator(
  namespace: string,
  action: string,
  options: BrowserOperatorPermissionOptions = {},
): Promise<OperationPolicy> {
  const command = normalizeAction(action);
  const argumentValues = options.argumentValues ?? {};
  try {
    const policy = await evaluateOperationPolicyWithApprovals({
      site: namespace,
      command,
      description: `Browser operator ${action}`,
      adapterType: AdapterType.BROWSER,
      targetSurface: "web",
      strategy: Strategy.UI,
      browser: true,
      domain: domainFromArguments(argumentValues),
      args: Object.keys(argumentValues).map((name) => ({ name })),
      profile: options.profile,
      approved: options.approved,
      effect: browserOperatorEffect(command, argumentValues),
      argumentValues,
    });
    if (policy.enforcement === "deny") {
      const id = policy.deny_rule?.id ?? "unknown";
      const reason = policy.deny_rule?.reason ?? policy.reason;
      throw new BrowserOperatorPermissionError({
        message: `permission rule "${id}" denies ${policy.effect}: ${reason}`,
        code: "permission_denied",
        suggestion:
          policy.approval_hint ?? "edit or remove the matching permission rule",
        exitCode: 77,
      });
    }
    if (policy.enforcement === "needs_approval") {
      throw new BrowserOperatorPermissionError({
        message: `permission profile "${policy.profile}" requires approval for ${policy.effect}`,
        code: "permission_denied",
        suggestion:
          policy.approval_hint ??
          "rerun with --yes or use --permission-profile open",
        exitCode: 77,
      });
    }
    if (options.rememberApproval === true) {
      try {
        await rememberApproval(createApprovalStore(), { policy });
      } catch (error) {
        throw new BrowserOperatorPermissionError({
          message: `failed to persist approval memory: ${errorMessage(error)}`,
          code: "invalid_input",
          suggestion:
            "repair ~/.unicli permissions or omit --remember-approval",
          exitCode: 78,
        });
      }
    }
    return policy;
  } catch (error) {
    if (error instanceof BrowserOperatorPermissionError) throw error;
    if (
      error instanceof InvalidPermissionProfileError ||
      error instanceof PermissionRulesConfigError
    ) {
      throw new BrowserOperatorPermissionError({
        message: error.message,
        code: "invalid_input",
        suggestion:
          error instanceof PermissionRulesConfigError
            ? error.suggestion
            : "use one of: open, confirm, locked",
        exitCode: 2,
      });
    }
    throw error;
  }
}

export function browserOperatorEffect(
  command: string,
  arguments_: Record<string, unknown>,
): OperationEffect {
  if (command === "screenshot") {
    return nonEmptyString(arguments_.path) ? "download_file" : "read";
  }
  if (command === "evidence") {
    return arguments_.screenshot === false ? "read" : "download_file";
  }
  if (command === "extract") {
    return arguments_.renderAware === true && arguments_.screenshot !== false
      ? "download_file"
      : "read";
  }
  if (command === "observe") return "local_file";
  if (command === "network") {
    return nonEmptyString(arguments_.detail) ? "read" : "local_file";
  }
  if (command === "cookies" || command === "init") return "local_file";
  if (command === "generate") return "local_file";
  if (command === "verify") {
    return arguments_.writeFixture === true || arguments_.updateFixture === true
      ? "local_file"
      : "read";
  }
  if (
    command === "native_host_install" ||
    command === "native_host_uninstall"
  ) {
    return "local_file";
  }
  if (command === "doctor") {
    return arguments_.repair === true ? "local_app" : "read";
  }
  if (command === "console" && arguments_.clear === true) return "local_app";
  if (command === "dialogs" && arguments_.clearRecent === true) {
    return "local_app";
  }
  if (READ_ACTIONS.has(command)) return "read";
  return "local_app";
}

function normalizeAction(action: string): string {
  return action.trim().split(/\s+/).join("_");
}

function domainFromArguments(
  arguments_: Record<string, unknown>,
): string | undefined {
  const raw = arguments_.url;
  if (typeof raw !== "string") return undefined;
  try {
    return new URL(raw).hostname;
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
