/**
 * @owner Uni-CLI Kernel
 * @does Implements explicit cancellable invocation stages shared by execute() and tests.
 * @needs Invocation, compiled command cache, policy evaluator, pipeline runner.
 * @feeds CLI/MCP/ACP kernel execution and stage parity tests.
 * @breaks Any surface that bypasses compile, validate, harden, authorize, execute, observe, envelope, or repair diagnostics.
 * @invariants Request cancellation reaches live work; settled fulfillment wins, while cancellation-caused rejection after mutating dispatch stays outcome-ambiguous.
 */

import { PipelineError, runPipeline } from "../executor.js";
import { hardenArgs, InputHardeningError } from "../harden.js";
import {
  defaultSuccessNextActions,
  defaultErrorNextActions,
} from "../../output/next-actions.js";
import { buildBrowserCommandDiagnostic } from "../browser/diagnostics.js";
import { createApprovalStore, rememberApproval } from "../approval-store.js";
import {
  errorTypeToCode,
  errorToAgentFields,
  mapErrorToExitCode,
} from "../../output/error-map.js";
import { commandAuthSetupCommand, commandStrategy } from "../../registry.js";
import type { AgentError } from "../../output/envelope.js";
import {
  ExitCode,
  type AdapterCommand,
  type BrowserSessionPreference,
} from "../../types.js";
import type { OperationPolicy } from "../operation-policy.js";
import {
  InvalidPermissionProfileError,
  resolveOperationAdapterPath,
  resolveOperationTargetSurface,
} from "../operation-policy.js";
import { evaluateOperationPolicyWithApprovals } from "../permission-runtime.js";
import { PermissionRulesConfigError } from "../permission-rules.js";
import { settleDispatchedAction } from "../../transport/action-settlement.js";
import { findOperationOutcomeAmbiguousError } from "../../transport/contained-process.js";
import { defaultEffectVerdict } from "../../core/effect-verdict.js";
import { inferOperationEffect } from "../operation-policy.js";

import { getCompiled } from "./compile.js";
import { KernelLookupError } from "./errors.js";
import type {
  CompiledCommand,
  Invocation,
  InvocationDiagnostic,
  InvocationResult,
} from "./types.js";

export const KERNEL_STAGE_ORDER = [
  "compile",
  "validate",
  "harden",
  "authorize",
  "execute",
  "observe",
  "envelope",
  "repair-diagnostics",
] as const;

export type KernelStageName = (typeof KERNEL_STAGE_ORDER)[number];

export interface KernelCommandContext {
  key: string;
  compiled: CompiledCommand;
  strategy: ReturnType<typeof commandStrategy>;
  targetSurface: ReturnType<typeof resolveOperationTargetSurface>;
  adapterPath: string;
}

export interface KernelStageFailure {
  stage: KernelStageName;
  result: InvocationResult;
}

export type KernelAuthorizeStage =
  | { stage: "authorize"; policy: OperationPolicy; blocked?: undefined }
  | { stage: "authorize"; policy?: undefined; blocked: KernelStageFailure };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resourcesFromPermissionConfig(
  config: unknown,
): Record<string, string[]> | undefined {
  if (!isRecord(config) || !isRecord(config.resources)) return undefined;

  const resources: Record<string, string[]> = {};
  for (const [bucket, raw] of Object.entries(config.resources)) {
    if (!Array.isArray(raw)) continue;
    const values = raw.filter((value): value is string => {
      return typeof value === "string";
    });
    if (values.length > 0) resources[bucket] = values;
  }

  return Object.keys(resources).length > 0 ? resources : undefined;
}

function runtimePermissionDeniedDiagnostic(
  err: unknown,
): InvocationDiagnostic | undefined {
  if (
    !(err instanceof PipelineError) ||
    err.detail.errorType !== "permission_denied"
  ) {
    return undefined;
  }

  const config = err.detail.config;
  const resources = resourcesFromPermissionConfig(config);
  const ruleId =
    isRecord(config) && typeof config.rule_id === "string"
      ? config.rule_id
      : undefined;

  return {
    kind: "runtime_permission_denied",
    code: "permission_denied",
    action: err.detail.action,
    step: err.detail.step,
    retryable: err.detail.retryable ?? false,
    ...(ruleId ? { rule_id: ruleId } : {}),
    resource_buckets: resources ? Object.keys(resources).sort() : [],
    ...(resources ? { resources } : {}),
  };
}

export function diagnosticsForError(
  err: unknown,
): InvocationDiagnostic[] | undefined {
  const diagnostic = runtimePermissionDeniedDiagnostic(err);
  return diagnostic ? [diagnostic] : undefined;
}

function browserDiagnostics(
  inv: Invocation,
  ctx: KernelCommandContext,
): InvocationDiagnostic[] | undefined {
  const diagnostic = buildBrowserCommandDiagnostic({
    site: inv.adapter.name,
    command: inv.cmdName,
    adapterPath: ctx.adapterPath,
    targetSurface: ctx.targetSurface,
    browser: inv.adapter.browser === true || inv.command.browser === true,
    domain: inv.command.domain ?? inv.adapter.domain,
  });
  return diagnostic ? [diagnostic] : undefined;
}

export function resolveKernelCommandContext(
  inv: Invocation,
): KernelCommandContext {
  const key = `${inv.adapter.name}.${inv.cmdName}`;
  const compiled = getCompiled(inv.adapter.name, inv.cmdName);
  if (!compiled) throw new KernelLookupError(key);

  const strategy = commandStrategy(inv.adapter, inv.command);
  const targetSurface = resolveOperationTargetSurface({
    adapterType: inv.adapter.type,
    targetSurface: inv.command.target_surface,
  });
  const adapterPath = resolveOperationAdapterPath(
    inv.adapter.name,
    inv.cmdName,
    inv.command.adapter_path,
  );

  return { key, compiled, strategy, targetSurface, adapterPath };
}

function errorResult(input: {
  inv: Invocation;
  ctx: KernelCommandContext;
  startedAt: number;
  warnings: string[];
  error: AgentError;
  exitCode: number;
  nextActionCode?: string;
  diagnostics?: InvocationDiagnostic[];
  effectPhase?: "pre_dispatch" | "dispatched_failure";
}): InvocationResult {
  const durationMs = Date.now() - input.startedAt;
  const effect = inferOperationEffect({
    site: input.inv.adapter.name,
    command: input.inv.cmdName,
    description: input.inv.command.description,
    adapterType: input.inv.adapter.type,
    targetSurface: input.ctx.targetSurface,
    strategy: input.ctx.strategy,
    browser:
      input.inv.adapter.browser === true || input.inv.command.browser === true,
    effect: input.inv.command.operation_effect,
  });
  const effectVerdict = defaultEffectVerdict({
    canMutate: effect !== "read",
    phase: input.effectPhase ?? "pre_dispatch",
  });
  return {
    results: [],
    envelope: {
      command: input.ctx.key,
      duration_ms: durationMs,
      adapter_version: input.inv.adapter.version,
      surface: input.ctx.targetSurface,
      effect_verdict: effectVerdict,
      error: input.error,
      ...(input.nextActionCode
        ? {
            next_actions: defaultErrorNextActions(
              input.inv.adapter.name,
              input.inv.cmdName,
              input.nextActionCode,
              input.inv.command.domain ?? input.inv.adapter.domain,
              {
                setupCommand: commandAuthSetupCommand(
                  input.inv.adapter,
                  input.inv.command,
                ),
                alternatives: input.error.alternatives,
              },
            ),
          }
        : {}),
    },
    durationMs,
    exitCode: input.exitCode,
    warnings: input.warnings,
    effectVerdict,
    error: input.error,
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  };
}

export function validateKernelInput(
  inv: Invocation,
  ctx: KernelCommandContext,
  startedAt: number,
  warnings: string[],
): KernelStageFailure | undefined {
  const validation = ctx.compiled.validate(inv.bag.args);
  if (validation.ok) return undefined;

  const first = validation.errors[0] ?? { message: "invalid arguments" };
  const path = (first.instancePath ?? "").replace(/^\//, "");
  const name = path || "args";
  const error: AgentError = {
    code: "invalid_input",
    message: `arg "${name}" ${first.message ?? "invalid"}`,
    adapter_path: ctx.adapterPath,
    step: 0,
    stage: "validate",
    suggestion: `match the JSON Schema at \`unicli describe ${inv.adapter.name} ${inv.cmdName}\``,
    retryable: false,
  };

  return {
    stage: "validate",
    result: errorResult({
      inv,
      ctx,
      startedAt,
      warnings,
      error,
      exitCode: ExitCode.USAGE_ERROR,
      nextActionCode: "invalid_input",
    }),
  };
}

export function hardenKernelInput(
  inv: Invocation,
  ctx: KernelCommandContext,
  startedAt: number,
  warnings: string[],
): KernelStageFailure | undefined {
  try {
    const hardened = hardenArgs(inv.bag.args, ctx.compiled.argByName);
    warnings.push(...hardened.warnings);
    return undefined;
  } catch (err) {
    if (!(err instanceof InputHardeningError)) throw err;
    const error: AgentError = {
      code: "invalid_input",
      message: err.message,
      adapter_path: ctx.adapterPath,
      step: 0,
      stage: "harden",
      suggestion: err.suggestion,
      retryable: false,
    };
    return {
      stage: "harden",
      result: errorResult({
        inv,
        ctx,
        startedAt,
        warnings,
        error,
        exitCode: ExitCode.USAGE_ERROR,
        nextActionCode: "invalid_input",
      }),
    };
  }
}

export async function authorizeKernelInvocation(
  inv: Invocation,
  ctx: KernelCommandContext,
  startedAt: number,
  warnings: string[],
): Promise<KernelAuthorizeStage> {
  try {
    const policy = await evaluateOperationPolicyWithApprovals({
      site: inv.adapter.name,
      command: inv.cmdName,
      description: inv.command.description,
      adapterType: inv.adapter.type,
      targetSurface: ctx.targetSurface,
      strategy: ctx.strategy,
      domain: inv.command.domain ?? inv.adapter.domain,
      base: inv.command.base ?? inv.adapter.base,
      browser: inv.adapter.browser === true || inv.command.browser === true,
      args: inv.command.adapterArgs,
      capabilities: inv.command.capabilities,
      executables: inv.command.executables,
      minimumCapability: inv.command.minimum_capability,
      effect: inv.command.operation_effect,
      profile: inv.permissionProfile,
      approved: inv.approved,
      argumentValues: inv.bag.args,
    });

    if (policy.enforcement === "deny") {
      const ruleId = policy.deny_rule?.id ?? "unknown";
      const ruleReason = policy.deny_rule?.reason ?? "permission rule matched";
      const error: AgentError = {
        code: "permission_denied",
        message: `permission rule "${ruleId}" denies ${policy.effect}: ${ruleReason}`,
        adapter_path: ctx.adapterPath,
        step: 0,
        stage: "authorize",
        suggestion:
          policy.approval_hint ?? "edit or remove the matching permission rule",
        retryable: false,
        alternatives: [
          `unicli --dry-run ${inv.adapter.name} ${inv.cmdName}`,
          "edit ~/.unicli/permission-rules.json",
        ],
      };
      return {
        stage: "authorize",
        blocked: {
          stage: "authorize",
          result: errorResult({
            inv,
            ctx,
            startedAt,
            warnings,
            error,
            exitCode: ExitCode.AUTH_REQUIRED,
            nextActionCode: "permission_denied",
          }),
        },
      };
    }

    if (policy.enforcement === "needs_approval") {
      const error: AgentError = {
        code: "permission_denied",
        message: `permission profile "${policy.profile}" requires approval for ${policy.effect}`,
        adapter_path: ctx.adapterPath,
        step: 0,
        stage: "authorize",
        suggestion:
          policy.approval_hint ??
          "rerun with --yes or use --permission-profile open",
        retryable: false,
        alternatives: [
          `unicli --dry-run ${inv.adapter.name} ${inv.cmdName}`,
          `unicli --yes --permission-profile ${policy.profile} ${inv.adapter.name} ${inv.cmdName}`,
          `unicli --permission-profile open ${inv.adapter.name} ${inv.cmdName}`,
        ],
      };
      return {
        stage: "authorize",
        blocked: {
          stage: "authorize",
          result: errorResult({
            inv,
            ctx,
            startedAt,
            warnings,
            error,
            exitCode: ExitCode.AUTH_REQUIRED,
            nextActionCode: "permission_denied",
          }),
        },
      };
    }

    return { stage: "authorize", policy };
  } catch (err) {
    if (err instanceof InvalidPermissionProfileError) {
      const error: AgentError = {
        code: "invalid_input",
        message: err.message,
        adapter_path: ctx.adapterPath,
        step: 0,
        stage: "authorize",
        suggestion: "use one of: open, confirm, locked",
        retryable: false,
      };
      return {
        stage: "authorize",
        blocked: {
          stage: "authorize",
          result: errorResult({
            inv,
            ctx,
            startedAt,
            warnings,
            error,
            exitCode: ExitCode.USAGE_ERROR,
            nextActionCode: "invalid_input",
          }),
        },
      };
    }
    if (err instanceof PermissionRulesConfigError) {
      const error: AgentError = {
        code: err.code,
        message: err.message,
        adapter_path: ctx.adapterPath,
        step: 0,
        stage: "authorize",
        suggestion: err.suggestion,
        retryable: false,
      };
      return {
        stage: "authorize",
        blocked: {
          stage: "authorize",
          result: errorResult({
            inv,
            ctx,
            startedAt,
            warnings,
            error,
            exitCode: ExitCode.USAGE_ERROR,
            nextActionCode: "invalid_input",
          }),
        },
      };
    }
    throw err;
  }
}

export async function rememberKernelApproval(
  inv: Invocation,
  policy: OperationPolicy,
  warnings: string[],
): Promise<void> {
  if (inv.rememberApproval !== true) return;
  try {
    await rememberApproval(createApprovalStore(), { policy });
  } catch (error) {
    warnings.push(
      `failed to persist approval memory: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function executeKernelCommand(
  inv: Invocation,
  ctx: KernelCommandContext,
  canMutate: boolean,
  warnings: string[],
): Promise<unknown[]> {
  const browserSession = resolveBrowserSessionPreference(
    inv.command,
    ctx.strategy,
  );
  if (inv.command.pipeline) {
    return runPipeline(inv.command.pipeline, inv.bag, inv.adapter.base, {
      site: inv.adapter.name,
      command: inv.cmdName,
      strategy: ctx.strategy,
      domain: inv.command.domain ?? inv.adapter.domain,
      browserSession,
      surface: inv.surface,
      trace_id: inv.trace_id,
      signal: inv.signal,
      canMutate,
    });
  }

  if (inv.command.func) {
    const commandFunc = inv.command.func;
    let page: unknown = null;
    try {
      if (inv.command.browser === true) {
        const { acquirePage } = await import("../steps/browser-helpers.js");
        page = await acquirePage({
          data: null,
          args: inv.bag.args,
          vars: {},
          base: inv.adapter.base,
          source: inv.bag.source,
          surface: inv.surface,
          trace_id: inv.trace_id,
          site: inv.adapter.name,
          command: inv.cmdName,
          domain: inv.command.domain ?? inv.adapter.domain,
          browserSession,
          signal: inv.signal,
          canMutate,
        });
      }
      const raw = await settleDispatchedAction(
        ctx.key,
        canMutate,
        inv.signal,
        () => commandFunc(page as never, inv.bag.args, { signal: inv.signal }),
      );
      return Array.isArray(raw) ? raw : [raw];
    } finally {
      if (page && typeof page === "object" && "close" in page) {
        try {
          await Promise.resolve((page as { close: () => unknown }).close());
        } catch (error) {
          const errorCode =
            error &&
            typeof error === "object" &&
            "code" in error &&
            typeof error.code === "string"
              ? ` (${error.code.slice(0, 64)})`
              : "";
          warnings.push(
            `browser cleanup failed for ${ctx.key}${errorCode}; the target or lease may remain active, so inspect \`unicli browser status --json\` before the next browser action`,
          );
        }
      }
    }
  }

  throw new Error(`command ${ctx.key} has neither pipeline nor func`);
}

function resolveBrowserSessionPreference(
  command: AdapterCommand,
  strategy: KernelCommandContext["strategy"],
): BrowserSessionPreference | undefined {
  if (command.browserSession) return command.browserSession;
  if (
    command.browser === true &&
    (strategy === "cookie" || strategy === "header" || strategy === "intercept")
  ) {
    return "user";
  }
  return undefined;
}

export function malformedCommandResult(
  inv: Invocation,
  ctx: KernelCommandContext,
  startedAt: number,
  warnings: string[],
): KernelStageFailure {
  const error: AgentError = {
    code: "internal_error",
    message: `command ${ctx.key} has neither pipeline nor func`,
    adapter_path: ctx.adapterPath,
    step: 0,
    stage: "execute",
    suggestion:
      "the adapter manifest is broken; run `unicli repair` to regenerate",
    retryable: false,
  };
  return {
    stage: "execute",
    result: errorResult({
      inv,
      ctx,
      startedAt,
      warnings,
      error,
      exitCode: ExitCode.CONFIG_ERROR,
    }),
  };
}

export function executionErrorResult(
  inv: Invocation,
  ctx: KernelCommandContext,
  startedAt: number,
  warnings: string[],
  err: unknown,
): KernelStageFailure {
  const ambiguity = findOperationOutcomeAmbiguousError(err);
  const fields = errorToAgentFields(
    err,
    ctx.adapterPath,
    inv.adapter.name,
    inv.cmdName,
    inv.command.domain ?? inv.adapter.domain,
  );
  const error: AgentError = {
    code: errorTypeToCode(err),
    message:
      ambiguity?.message ?? (err instanceof Error ? err.message : String(err)),
    ...fields,
  };
  const diagnostics = [
    ...(diagnosticsForError(err) ?? []),
    ...(browserDiagnostics(inv, ctx) ?? []),
  ];
  return {
    stage: "repair-diagnostics",
    result: errorResult({
      inv,
      ctx,
      startedAt,
      warnings,
      error,
      exitCode: mapErrorToExitCode(err),
      nextActionCode: error.code,
      effectPhase: "dispatched_failure",
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    }),
  };
}

export function successKernelResult(
  inv: Invocation,
  ctx: KernelCommandContext,
  startedAt: number,
  warnings: string[],
  results: unknown[],
  effectVerdict = defaultEffectVerdict({
    canMutate:
      inferOperationEffect({
        site: inv.adapter.name,
        command: inv.cmdName,
        description: inv.command.description,
        adapterType: inv.adapter.type,
        targetSurface: ctx.targetSurface,
        strategy: ctx.strategy,
        browser: inv.adapter.browser === true || inv.command.browser === true,
        effect: inv.command.operation_effect,
      }) !== "read",
    phase: "success",
  }),
): InvocationResult {
  const durationMs = Date.now() - startedAt;
  const diagnostics = browserDiagnostics(inv, ctx);
  return {
    results,
    envelope: {
      command: ctx.key,
      duration_ms: durationMs,
      adapter_version: inv.adapter.version,
      surface: ctx.targetSurface,
      effect_verdict: effectVerdict,
      next_actions: defaultSuccessNextActions(inv.adapter.name, inv.cmdName, {
        supportsPagination: inv.command.paginated === true,
      }),
    },
    durationMs,
    exitCode: ExitCode.SUCCESS,
    warnings,
    effectVerdict,
    ...(diagnostics ? { diagnostics } : {}),
  };
}
