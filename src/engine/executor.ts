/**
 * YAML Pipeline Execution Engine — runPipeline orchestrator.
 *
 * Dispatches pipeline steps through `step-registry`. Per-step bodies live
 * in `steps/*.ts` and self-register on import. This file owns:
 *   - PipelineError shape
 *   - `executeStep` dispatch (registry → cua/ax bus → plugin registry)
 *   - `runPipeline` orchestration (cookies, retry, fallback, auto-fix,
 *     diagnostic, cookie refresh, temp-dir cleanup)
 *
 * Per-step recovery helpers live in `runtime.ts`.
 */

import { rmSync } from "node:fs";
import type { PipelineStep } from "../types.js";
import type { BrowserPage } from "../browser/page.js";
import { isTargetError } from "../browser/target-errors.js";
import { formatCookieHeader, loadCookiesWithCDP } from "./cookies.js";
import { CUA_STEP_HANDLERS, type CuaStepKind } from "./steps/cua.js";
import {
  DESKTOP_AX_STEP_HANDLERS,
  type DesktopAxStepKind,
} from "./steps/desktop-ax.js";
import { getStep } from "./step-registry.js";
import {
  getBus,
  buildTransportCtx,
  _resetTransportBusForTests,
} from "../transport/bus.js";
// Side-effect import: every per-step module self-registers on load.
import "./steps/index.js";

export { assertSafeRequestUrl } from "./ssrf.js";
export { getBus, buildTransportCtx, _resetTransportBusForTests };

export interface PipelineOptions {
  site?: string;
  strategy?: string;
}

export type PipelineContext = {
  data: unknown;
  args: Record<string, unknown>;
  vars: Record<string, unknown>;
  base?: string;
  cookieHeader?: string;
  temp?: Record<string, string>;
  tempDir?: string;
  page?: BrowserPage;
};

/** Structured pipeline error — designed for AI agent consumption. */
export class PipelineError extends Error {
  constructor(
    message: string,
    public readonly detail: {
      step: number;
      action: string;
      config: unknown;
      errorType:
        | "http_error"
        | "selector_miss"
        | "empty_result"
        | "parse_error"
        | "timeout"
        | "expression_error"
        | "assertion_failed"
        | "stale_ref"
        | "ambiguous"
        | "not_found";
      url?: string;
      statusCode?: number;
      responsePreview?: string;
      suggestion: string;
      retryable?: boolean;
      alternatives?: string[];
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

function isCuaStep(action: string): action is CuaStepKind {
  return action in CUA_STEP_HANDLERS;
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
  if (action === "rate_limit") {
    const rl = config as { domain: string; rpm?: number };
    const { waitForToken } = await import("./rate-limiter.js");
    await waitForToken(rl.domain, rl.rpm ?? 60);
    return ctx;
  }

  const handler = getStep(action);
  if (handler) return handler(ctx, config, stepIndex, fullStep, depth);

  if (isCuaStep(action) || isDesktopAxStep(action)) {
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

  return ctx;
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
  const handlerFn = isCuaStep(action)
    ? CUA_STEP_HANDLERS[action]
    : DESKTOP_AX_STEP_HANDLERS[action as DesktopAxStepKind];
  const envelope = await handlerFn(busCtx, params);
  ctx.vars["lastEnvelope"] = envelope;
  return { ...ctx, data: envelope.ok ? envelope.data : envelope };
}

export async function runPipeline(
  steps: PipelineStep[],
  args: Record<string, unknown>,
  base?: string,
  options?: PipelineOptions,
): Promise<unknown[]> {
  const rt = await import("./runtime.js");
  let cookieHeader: string | undefined;
  if (
    (options?.strategy === "cookie" || options?.strategy === "header") &&
    options?.site
  ) {
    const cookies = await loadCookiesWithCDP(options.site);
    if (!cookies) {
      throw new PipelineError(
        `No cookies found for "${options.site}". Run: unicli auth setup ${options.site}`,
        {
          step: -1,
          action: "auth",
          config: { site: options.site, strategy: options.strategy },
          errorType: "http_error",
          suggestion: `Either start Chrome with "unicli browser start" and login to ${options.site}, or create cookie file at ~/.unicli/cookies/${options.site}.json`,
          retryable: false,
          alternatives: [`unicli auth setup ${options.site}`],
        },
      );
    }
    cookieHeader = formatCookieHeader(cookies);
  }

  let ctx: PipelineContext = { data: null, args, vars: {}, base, cookieHeader };
  let tempDir: string | undefined;

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const [action, config] = getActionEntry(step);
      const { config: extracted, fallbacks } = rt.extractFallbacks(
        step,
        config,
      );
      const retryCount = rt.getRetryCount(step, extracted);
      const backoffMs = rt.getBackoffMs(step, extracted);
      const stepConfig = rt.stripRetryKeys(extracted);

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
          if (ctx.tempDir) tempDir = ctx.tempDir;
          continue;
        }

        await rt.emitDiagnosticIfEnabled(err, ctx, options?.site);
        await rt.maybeRefreshCookies(err, options);

        if (err instanceof PipelineError) throw err;
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
            .map(
              (c) => `ref:${c.ref} (${c.role}${c.name ? `: ${c.name}` : ""})`,
            );
          throw new PipelineError(err.message, {
            step: i,
            action,
            config,
            errorType: code,
            suggestion,
            retryable: code === "stale_ref",
            alternatives,
          });
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        const isTransient =
          /timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|socket hang up/i.test(
            errMsg,
          );
        throw new PipelineError(`Step ${i} (${action}) failed: ${errMsg}`, {
          step: i,
          action,
          config,
          errorType: isTransient ? "timeout" : "parse_error",
          suggestion: `Check the ${action} step at index ${i} in the adapter YAML. The expression or configuration may be invalid.`,
          retryable: isTransient,
          alternatives: [],
        });
      }

      if (ctx.tempDir) tempDir = ctx.tempDir;
    }

    const result = ctx.data;
    if (Array.isArray(result)) return result;
    if (result !== null && result !== undefined) return [result];
    return [];
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    if (ctx.page) {
      try {
        await ctx.page.close();
      } catch {
        /* best-effort */
      }
    }
  }
}
