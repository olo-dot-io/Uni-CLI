/**
 * @owner       src::engine::executor
 * @does        Orchestrates cancellable YAML pipelines and dispatches registered, transport-native, then plugin actions.
 * @needs       browser invocation context/scope, step registry/barrel, transport handler tables, operation args, cookie acquisition, runtime recovery, observer
 * @feeds       adapter execution across CLI/MCP/ACP and repair verification
 * @breaks      Unknown actions and step failures become typed PipelineError instances with owning step evidence; structured runtime errors retain their exact code and recovery guidance.
 * @invariants  Every built-in non-transport action is registry-owned; pre-dispatch cancellation is exact, settled fulfillment wins, and mutating partial completion is outcome-ambiguous; retry/fallback remain bounded sibling metadata.
 * @side-effects Executes network/browser/desktop/subprocess actions, observes steps, and cleans temporary directories.
 * @perf        O(pipeline length) orchestration excluding action-owned I/O.
 * @concurrency Parallelism exists only in explicit parallel/each handlers; the main pipeline is ordered.
 * @test        tests/unit/pipeline*.test.ts, tests/integration/repair-truth.test.ts
 * @stability   stable
 * @since       2026-04-01
 */

import { rmSync } from "node:fs";
import type { IPage, PipelineStep } from "../types.js";
import type { BrowserSessionPreference } from "../types.js";
import { createBrowserInvocationContext } from "../browser/invocation-context.js";
import {
  createBrowserInvocationScope,
  currentBrowserInvocationScope,
  runBrowserInvocation,
} from "../browser/invocation-scope.js";
import { isTargetError } from "../browser/target-errors.js";
import { acquireCookies, formatCookieHeader } from "./cookies.js";
import { describeCookieFailure } from "./cookie-source.js";
import { VISUAL_STEP_HANDLERS, type VisualStepKind } from "./steps/visual.js";
import {
  DESKTOP_AX_STEP_HANDLERS,
  type DesktopAxStepKind,
} from "./steps/desktop-ax.js";
import {
  DESKTOP_SIDECAR_STEP_HANDLERS,
  isDesktopSidecarStep,
} from "./steps/desktop-sidecar.js";
import { getStep } from "./step-registry.js";
import {
  getBus,
  buildTransportCtx,
  _resetTransportBusForTests,
} from "../transport/bus.js";
import type { ArgSource, ResolvedArgs } from "./args.js";
import { settleDispatchedAction } from "../transport/action-settlement.js";
import { isOperationOutcomeAmbiguousError } from "../transport/contained-process.js";
import {
  type StepObserver,
  type StepObservation,
  summarizeOutput,
} from "./step-observer.js";
// Side-effect import: every per-step module self-registers on load.
import "./steps/index.js";

export { assertSafeRequestUrl } from "./ssrf.js";
export { getBus, buildTransportCtx, _resetTransportBusForTests };

export interface PipelineOptions {
  site?: string;
  command?: string;
  strategy?: string;
  /**
   * Cookie domain declared by the adapter (or the command override). Drives
   * the browser-cookie source — without this the loader has to guess
   * `${site}.com`, which is wrong for sites like notion (`.notion.so`),
   * weixin (`mp.weixin.qq.com`), perplexity (`.perplexity.ai`), twitch
   * (`.twitch.tv`), linux-do (`linux.do`), etc.
   */
  domain?: string;
  /**
   * Kernel surface that dispatched the pipeline. When provided, becomes
   * `${{ surface }}` in YAML templates. Undefined for legacy callers
   * (dev/health/skills) — those set `source: "internal"` on the bag.
   */
  surface?: "cli" | "mcp" | "acp" | "bench" | "hub";
  /**
   * ULID trace ID from the kernel. Exposed as `${{ trace_id }}` in YAML
   * templates so adapters can correlate logs across surfaces. Undefined
   * for callers that do not route through the kernel.
   */
  trace_id?: string;
  /** Browser transport preference declared by a browser command. */
  browserSession?: BrowserSessionPreference;
  /**
   * Optional sink for per-step observations. When provided, runPipeline emits
   * one observation per executed step (timing + output shape on success,
   * errorType + message on failure). Additive side channel — never alters the
   * result/error envelope. Undefined = zero overhead (the default).
   */
  observer?: StepObserver;
  /** Request-owned cancellation propagated across pipeline and recovery boundaries. */
  signal?: AbortSignal;
  /** Whether the authorized command can mutate external state. Defaults true for direct callers. */
  canMutate?: boolean;
}

export type PipelineContext = {
  data: unknown;
  args: Record<string, unknown>;
  vars: Record<string, unknown>;
  base?: string;
  cookieHeader?: string;
  temp?: Record<string, string>;
  tempDir?: string;
  page?: IPage;
  browserSession?: BrowserSessionPreference;
  /** Adapter auth domain used for browser cookie bootstrap. */
  domain?: string;
  /** Provenance of `args` — seeded from `ResolvedArgs.source`. */
  source?: ArgSource;
  /** Surface that dispatched this pipeline. Mirrors `PipelineOptions.surface`. */
  surface?: "cli" | "mcp" | "acp" | "bench" | "hub";
  /** Kernel trace ID. Mirrors `PipelineOptions.trace_id`. */
  trace_id?: string;
  /** Adapter site that owns this pipeline, when routed through the kernel. */
  site?: string;
  /** Adapter command that owns this pipeline, when routed through the kernel. */
  command?: string;
  /** Request-owned cancellation propagated to nested and browser steps. */
  signal?: AbortSignal;
  /** Whether the owning command can mutate external state. */
  canMutate: boolean;
};

/** Structured pipeline error — designed for AI agent consumption. */
export class PipelineError extends Error {
  constructor(
    message: string,
    public readonly detail: {
      step: number;
      action: string;
      config: unknown;
      errorType: string;
      url?: string;
      statusCode?: number;
      responsePreview?: string;
      suggestion: string;
      retryable?: boolean;
      alternatives?: string[];
      preserveErrorCode?: boolean;
    },
  ) {
    super(message);
    this.name = "PipelineError";
  }

  toAgentJSON(adapterPath?: string) {
    return {
      error: this.message,
      adapter: adapterPath,
      ...this.detail,
      retryable: this.detail.retryable ?? false,
      alternatives: this.detail.alternatives ?? [],
    };
  }
}

const SIBLING_KEYS = new Set([
  "fallback",
  "then",
  "else",
  "merge",
  "retry",
  "backoff",
]);

function isVisualStep(action: string): action is VisualStepKind {
  return action in VISUAL_STEP_HANDLERS;
}

function isDesktopAxStep(action: string): action is DesktopAxStepKind {
  return action in DESKTOP_AX_STEP_HANDLERS;
}

export function getActionEntry(step: PipelineStep): [string, unknown] {
  const entries = Object.entries(step);
  return (entries.find(([k]) => !SIBLING_KEYS.has(k)) ?? entries[0]) as [
    string,
    unknown,
  ];
}

export async function executeStep(
  ctx: PipelineContext,
  action: string,
  config: unknown,
  stepIndex: number,
  fullStep?: PipelineStep,
  depth?: number,
): Promise<PipelineContext> {
  ctx.signal?.throwIfAborted();
  const handler = getStep(action);
  if (handler) {
    return handler(ctx, config, stepIndex, fullStep, depth);
  }

  if (
    isVisualStep(action) ||
    isDesktopAxStep(action) ||
    isDesktopSidecarStep(action)
  ) {
    return dispatchBusStep(ctx, action, config);
  }

  const { getCustomStep } = await import("../plugin/step-registry.js");
  const customHandler = getCustomStep(action);
  if (customHandler) {
    const pluginCtx = {
      data: ctx.data,
      args: ctx.args,
      vars: ctx.vars,
      base: ctx.base,
      cookieHeader: ctx.cookieHeader,
    };
    const result = await customHandler(pluginCtx, config);
    return { ...ctx, data: result.data, vars: result.vars };
  }

  throw new PipelineError(
    `Unknown pipeline step action "${action}" at step ${stepIndex} — not a registered step, visual/ax/sidecar handler, or plugin step.`,
    {
      step: stepIndex,
      action,
      config,
      errorType: "unknown_action",
      suggestion: `Step ${stepIndex} names "${action}", which is not a known pipeline step. Run \`unicli list\` for valid steps, or fix the typo in the adapter YAML.`,
      retryable: false,
      alternatives: [],
    },
  );
}

/**
 * Build the structured PipelineError for a step failure. Centralizes the
 * error-shaping that the runPipeline catch used to inline across four branches,
 * so the same error can be both observed and thrown. A PipelineError thrown by
 * a step (e.g. the unknown-action guard, fetch http errors) passes through
 * verbatim; only raw/target/HTTP-message errors are wrapped.
 */
function buildPipelineError(
  err: unknown,
  stepIndex: number,
  action: string,
  config: unknown,
  options?: PipelineOptions,
): PipelineError {
  if (err instanceof PipelineError) return err;
  if (isTargetError(err)) {
    const code = err.detail.code;
    const suggestion =
      code === "stale_ref"
        ? `Re-take a snapshot before the ${action} step — the page has changed.`
        : code === "ambiguous"
          ? `Ref ${err.detail.ref} matches multiple elements; narrow the ref via a fresh snapshot.`
          : `Ref ${err.detail.ref} is not on the page; re-take a snapshot.`;
    const alternatives = (err.detail.candidates ?? [])
      .slice(0, 5)
      .map((c) => `ref:${c.ref} (${c.role}${c.name ? `: ${c.name}` : ""})`);
    return new PipelineError(err.message, {
      step: stepIndex,
      action,
      config,
      errorType: code,
      suggestion,
      retryable: code === "stale_ref",
      alternatives,
    });
  }
  if (isStructuredActionableError(err)) {
    return new PipelineError(err.message, {
      step: stepIndex,
      action,
      config,
      errorType: err.code,
      suggestion: err.suggestion,
      retryable: err.retryable,
      alternatives: err.alternatives ?? [],
      preserveErrorCode: true,
    });
  }
  const errMsg = err instanceof Error ? err.message : String(err);
  const httpStatus = /\bHTTP\s+(\d{3})\b/i.exec(errMsg)?.[1];
  if (httpStatus) {
    const statusCode = Number(httpStatus);
    const retryable =
      statusCode === 429 ||
      statusCode === 500 ||
      statusCode === 502 ||
      statusCode === 503 ||
      statusCode === 504;
    return new PipelineError(
      `Step ${stepIndex} (${action}) failed: ${errMsg}`,
      {
        step: stepIndex,
        action,
        config,
        errorType: "http_error",
        statusCode,
        suggestion:
          statusCode === 401 || statusCode === 403
            ? `Refresh login state with \`unicli --auth-retry ${options?.site ?? "<site>"} <command> --args-file <path.json>\`, or open the site in Chrome and complete login/challenge.`
            : statusCode === 429
              ? "The upstream site rate-limited the request. Wait, lower --limit, then retry."
              : `The browser-side request returned HTTP ${statusCode}. Retry once; if it persists, inspect the adapter endpoint with \`unicli repair ${options?.site ?? "<site>"} <command>\`.`,
        retryable,
        alternatives:
          statusCode === 401 || statusCode === 403
            ? [`unicli auth import ${options?.site ?? "<site>"}`]
            : [],
      },
    );
  }
  const isTransient =
    /timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|socket hang up/i.test(errMsg);
  return new PipelineError(`Step ${stepIndex} (${action}) failed: ${errMsg}`, {
    step: stepIndex,
    action,
    config,
    errorType: isTransient ? "timeout" : "parse_error",
    suggestion: `Check the ${action} step at index ${stepIndex} in the adapter YAML. The expression or configuration may be invalid.`,
    retryable: isTransient,
    alternatives: [],
  });
}

function isStructuredActionableError(error: unknown): error is Error & {
  code: string;
  suggestion: string;
  retryable: boolean;
  alternatives?: string[];
} {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & {
    code?: unknown;
    suggestion?: unknown;
    retryable?: unknown;
    alternatives?: unknown;
  };
  return (
    typeof candidate.code === "string" &&
    candidate.code.length > 0 &&
    typeof candidate.suggestion === "string" &&
    candidate.suggestion.length > 0 &&
    typeof candidate.retryable === "boolean" &&
    (candidate.alternatives === undefined ||
      (Array.isArray(candidate.alternatives) &&
        candidate.alternatives.every(
          (alternative) => typeof alternative === "string",
        )))
  );
}

/**
 * Emit a step observation through the sink, guarding against a misbehaving
 * observer. Observation is a side channel that must never break a run.
 */
function recordObservation(
  observer: StepObserver | undefined,
  observation: StepObservation,
): void {
  if (!observer) return;
  try {
    observer.record(observation);
  } catch {
    // REASON: step observation is a side channel; a misbehaving observer must
    // never break or alter a pipeline run (same invariant the run recorder holds).
  }
}

async function dispatchBusStep(
  ctx: PipelineContext,
  action: string,
  config: unknown,
): Promise<PipelineContext> {
  const params =
    config && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, unknown>)
      : {};
  const busCtx = { bus: getBus(), transportCtx: buildTransportCtx(ctx) };
  const handlerFn = isVisualStep(action)
    ? VISUAL_STEP_HANDLERS[action]
    : isDesktopSidecarStep(action)
      ? DESKTOP_SIDECAR_STEP_HANDLERS[action]
      : DESKTOP_AX_STEP_HANDLERS[action as DesktopAxStepKind];
  const envelope = await handlerFn(busCtx, params);
  ctx.vars["lastEnvelope"] = envelope;
  return { ...ctx, data: envelope.ok ? envelope.data : envelope };
}

export async function runPipeline(
  steps: PipelineStep[],
  bag: ResolvedArgs,
  base?: string,
  options?: PipelineOptions,
): Promise<unknown[]> {
  if (currentBrowserInvocationScope()) {
    return runPipelineInInvocation(steps, bag, base, options);
  }
  const context = createBrowserInvocationContext({
    transport: pipelineInvocationTransport(options?.surface),
    ...(options?.trace_id ? { turnId: options.trace_id } : {}),
  });
  const scope = createBrowserInvocationScope({
    context,
    ...(options?.signal ? { signal: options.signal } : {}),
  });
  return runBrowserInvocation(scope, () =>
    runPipelineInInvocation(steps, bag, base, options),
  );
}

async function runPipelineInInvocation(
  steps: PipelineStep[],
  bag: ResolvedArgs,
  base?: string,
  options?: PipelineOptions,
): Promise<unknown[]> {
  options?.signal?.throwIfAborted();
  const rt = await import("./runtime.js");
  let cookieHeader: string | undefined;
  if (
    (options?.strategy === "cookie" || options?.strategy === "header") &&
    options?.site
  ) {
    const outcome = await acquireCookies(options.site, options.domain);
    options.signal?.throwIfAborted();
    if (outcome.status !== "loaded") {
      const failure = describeCookieFailure(
        outcome,
        options.site,
        options.domain,
      );
      throw new PipelineError(failure.message, {
        step: -1,
        action: "auth",
        config: { site: options.site, strategy: options.strategy },
        errorType: "http_error",
        suggestion: failure.suggestion,
        retryable: failure.retryable,
        alternatives: [`unicli auth import ${options.site}`],
      });
    }
    cookieHeader = formatCookieHeader(outcome.cookies);
  }

  let ctx: PipelineContext = {
    data: null,
    args: bag.args,
    vars: {},
    base,
    cookieHeader,
    source: bag.source,
    surface: options?.surface,
    trace_id: options?.trace_id,
    site: options?.site,
    command: options?.command,
    domain: options?.domain,
    browserSession: options?.browserSession,
    signal: options?.signal,
    canMutate: options?.canMutate ?? true,
  };
  let tempDir: string | undefined;
  let executionFailed = false;
  let executionError: unknown;
  let pipelineResult: unknown[] = [];

  try {
    const operation =
      [options?.site, options?.command].filter(Boolean).join(".") || "pipeline";
    pipelineResult = await settleDispatchedAction(
      operation,
      ctx.canMutate,
      ctx.signal,
      async () => {
        for (let i = 0; i < steps.length; i++) {
          ctx.signal?.throwIfAborted();
          const step = steps[i];
          const [action, config] = getActionEntry(step);
          const { config: extracted, fallbacks } = rt.extractFallbacks(
            step,
            config,
          );
          const retryCount = rt.getRetryCount(step, extracted);
          const backoffMs = rt.getBackoffMs(step, extracted);
          const stepConfig = rt.stripRetryKeys(extracted);

          const startedAt = performance.now();
          try {
            ctx =
              retryCount > 0
                ? await rt.runWithRetry(
                    ctx,
                    action,
                    stepConfig,
                    fallbacks,
                    retryCount,
                    backoffMs,
                    i,
                    step,
                  )
                : await rt.runWithFallbacks(
                    ctx,
                    action,
                    stepConfig,
                    fallbacks,
                    i,
                    step,
                  );
          } catch (err) {
            if (isOperationOutcomeAmbiguousError(err) || ctx.signal?.aborted) {
              throw err;
            }
            const fixed = options?.site
              ? await rt.tryAutoFixSelect(
                  err,
                  ctx,
                  action,
                  stepConfig,
                  i,
                  options.site,
                )
              : undefined;
            if (fixed) {
              ctx = fixed;
              recordObservation(options?.observer, {
                index: i,
                action,
                status: "ok",
                durationMs: performance.now() - startedAt,
                output: summarizeOutput(ctx.data),
              });
              if (ctx.tempDir) tempDir = ctx.tempDir;
              continue;
            }

            if (ctx.signal?.aborted) throw err;
            await rt.emitDiagnosticIfEnabled(err, ctx, options?.site);
            if (ctx.signal?.aborted) throw err;
            await rt.maybeRefreshCookies(err, options);

            const pipelineError = buildPipelineError(
              err,
              i,
              action,
              config,
              options,
            );
            recordObservation(options?.observer, {
              index: i,
              action,
              status: "error",
              durationMs: performance.now() - startedAt,
              errorType: pipelineError.detail.errorType,
              errorMessage: pipelineError.message,
            });
            throw pipelineError;
          }

          recordObservation(options?.observer, {
            index: i,
            action,
            status: "ok",
            durationMs: performance.now() - startedAt,
            output: summarizeOutput(ctx.data),
          });
          if (ctx.tempDir) tempDir = ctx.tempDir;
        }

        const result = ctx.data;
        if (Array.isArray(result)) return result;
        return result === null || result === undefined ? [] : [result];
      },
    );
  } catch (error) {
    executionFailed = true;
    executionError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (ctx.page) {
    try {
      await ctx.page.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (executionFailed) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [executionError, ...cleanupErrors],
        "Pipeline execution and resource cleanup both failed",
      );
    }
    throw executionError;
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "Pipeline resource cleanup failed");
  }
  return pipelineResult;
}

function pipelineInvocationTransport(
  surface: PipelineOptions["surface"],
): "cli" | "mcp-stdio" | "plugin" | "broker" {
  if (surface === "cli") return "cli";
  if (surface === "mcp") return "mcp-stdio";
  if (surface === "acp") return "plugin";
  return "broker";
}
