/**
 * @owner       src::engine::runtime
 * @does        Executes cancellable per-step fallback, retry, diagnostic, selector recovery, and authenticated-session refresh helpers.
 * @needs       executor pipeline types, step registry, diagnostic/select-fix/cookie-refresh lazy modules
 * @feeds       src::engine::executor pipeline orchestration
 * @breaks      Recovery failures remain subordinate to the original pipeline error but are reported on stderr.
 * @invariants  Retries are bounded, cancellation stops unsettled fallback/retry/backoff, outcome ambiguity is never replayed, domain-aware cookie refresh never persists, and settled results remain authoritative.
 * @side-effects May retry steps, sleep, emit diagnostics, mutate in-memory pipeline context, navigate Chrome, and write stderr.
 * @concurrency Each helper call owns its retry counter and pipeline context.
 * @test        tests/unit/engine/runtime-cookie-refresh.test.ts and pipeline executor suites
 * @stability   stable
 * @since       2026-04-01
 */

import type { PipelineStep } from "../types.js";
import { setTimeout as delay } from "node:timers/promises";
import {
  type PipelineContext,
  type PipelineOptions,
  PipelineError,
  executeStep,
} from "./executor.js";
import { getStep } from "./step-registry.js";
import { isOperationOutcomeAmbiguousError } from "../transport/contained-process.js";

export function extractFallbacks(
  step: PipelineStep,
  rawConfig: unknown,
): { config: unknown; fallbacks: unknown[] | undefined } {
  let config = rawConfig;
  let fallbacks: unknown[] | undefined;

  if (config && typeof config === "object" && !Array.isArray(config)) {
    const co = config as Record<string, unknown>;
    if ("fallback" in co) {
      fallbacks = Array.isArray(co.fallback) ? co.fallback : [co.fallback];
      const { fallback: _, ...rest } = co;
      config = rest;
    }
  }
  if (!fallbacks) {
    const so = step as Record<string, unknown>;
    if ("fallback" in so) {
      const fb = so.fallback;
      fallbacks = Array.isArray(fb) ? fb : [fb];
    }
  }
  if (fallbacks) {
    fallbacks = fallbacks.filter((fb) => fb != null);
    if (fallbacks.length === 0) fallbacks = undefined;
  }
  return { config, fallbacks };
}

export function getRetryCount(step: PipelineStep, config: unknown): number {
  const so = step as Record<string, unknown>;
  if (typeof so.retry === "number") return so.retry;
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const co = config as Record<string, unknown>;
    if ("retry" in co) return Number(co.retry) || 0;
  }
  return 0;
}

export function getBackoffMs(step: PipelineStep, config: unknown): number {
  const so = step as Record<string, unknown>;
  if (typeof so.backoff === "number") return so.backoff;
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const co = config as Record<string, unknown>;
    if ("backoff" in co) return Number(co.backoff) || 1000;
  }
  return 1000;
}

export function stripRetryKeys(config: unknown): unknown {
  if (!config || typeof config !== "object" || Array.isArray(config))
    return config;
  const co = config as Record<string, unknown>;
  if ("retry" in co || "backoff" in co) {
    const { retry: _r, backoff: _b, ...rest } = co;
    return rest;
  }
  return config;
}

export async function runWithFallbacks(
  ctx: PipelineContext,
  action: string,
  config: unknown,
  fallbacks: unknown[] | undefined,
  stepIndex: number,
  step: PipelineStep,
): Promise<PipelineContext> {
  ctx.signal?.throwIfAborted();
  try {
    return await executeStep(ctx, action, config, stepIndex, step);
  } catch (primaryErr) {
    if (isOperationOutcomeAmbiguousError(primaryErr) || ctx.signal?.aborted) {
      throw primaryErr;
    }
    if (!fallbacks || fallbacks.length === 0) throw primaryErr;
    let lastErr = primaryErr;
    for (const fb of fallbacks) {
      ctx.signal?.throwIfAborted();
      try {
        return await executeStep(ctx, action, fb, stepIndex, step);
      } catch (fbErr) {
        if (isOperationOutcomeAmbiguousError(fbErr) || ctx.signal?.aborted) {
          throw fbErr;
        }
        lastErr = fbErr;
      }
    }
    throw lastErr;
  }
}

export async function runWithRetry(
  ctx: PipelineContext,
  action: string,
  config: unknown,
  fallbacks: unknown[] | undefined,
  retryCount: number,
  backoffMs: number,
  stepIndex: number,
  step: PipelineStep,
): Promise<PipelineContext> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    ctx.signal?.throwIfAborted();
    try {
      return await runWithFallbacks(
        ctx,
        action,
        config,
        fallbacks,
        stepIndex,
        step,
      );
    } catch (err) {
      if (isOperationOutcomeAmbiguousError(err) || ctx.signal?.aborted) {
        throw err;
      }
      lastErr = err;
      if (attempt < retryCount) {
        await delay(backoffMs * Math.pow(2, attempt), undefined, {
          signal: ctx.signal,
        });
      }
    }
  }
  throw lastErr;
}

export async function tryAutoFixSelect(
  err: unknown,
  ctx: PipelineContext,
  action: string,
  stepConfig: unknown,
  stepIndex: number,
  site: string,
): Promise<PipelineContext | undefined> {
  if (
    action !== "select" ||
    !(err instanceof PipelineError) ||
    err.detail.errorType !== "selector_miss"
  ) {
    return undefined;
  }
  try {
    const { suggestSelectFix } = await import("./auto-fix.js");
    const suggestions = suggestSelectFix(ctx.data, stepConfig as string);
    const handler = getStep("select");
    if (!handler) return undefined;
    for (const suggestion of suggestions) {
      try {
        const fixed = (await handler(
          ctx,
          suggestion,
          stepIndex,
        )) as PipelineContext;
        process.stderr.write(
          `[auto-fix] ${site}: select path changed "${String(stepConfig)}" → "${suggestion}"\n`,
        );
        return fixed;
      } catch {
        /* try next suggestion */
      }
    }
  } catch {
    /* auto-fix module unavailable */
  }
  return undefined;
}

export async function emitDiagnosticIfEnabled(
  err: unknown,
  ctx: PipelineContext,
  site: string | undefined,
): Promise<void> {
  if (process.env.UNICLI_DIAGNOSTIC !== "1") return;
  try {
    const { buildRepairContext, emitRepairContext } =
      await import("./diagnostic.js");
    const repairCtx = await buildRepairContext({
      error: err instanceof Error ? err : new Error(String(err)),
      site: site ?? "unknown",
      command: "unknown",
      page: ctx.page,
    });
    emitRepairContext(repairCtx);
  } catch {
    /* never mask original error */
  }
}

export async function maybeRefreshCookies(
  err: unknown,
  options: PipelineOptions | undefined,
): Promise<void> {
  if (!(err instanceof PipelineError)) return;
  if (err.detail.statusCode !== 401 && err.detail.statusCode !== 403) return;
  if (options?.strategy !== "cookie" && options?.strategy !== "header") return;
  if (!options?.site) return;
  try {
    const { refreshCookies } = await import("./cookie-refresh.js");
    options.signal?.throwIfAborted();
    const outcome = options.signal
      ? await refreshCookies(
          options.site,
          options.domain,
          undefined,
          options.signal,
        )
      : await refreshCookies(options.site, options.domain);
    options.signal?.throwIfAborted();
    if (outcome.status === "refreshed") {
      process.stderr.write(
        `[cookie-refresh] refreshed ${outcome.cookieCount} cookie(s) for ${options.site}; retry the command.\n`,
      );
    } else {
      process.stderr.write(
        `[cookie-refresh] could not refresh ${options.site} (${outcome.status}): ${outcome.detail}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(
      `[cookie-refresh] recovery failed for ${options.site}: ${error instanceof Error ? error.message : String(error)}; the original pipeline error remains authoritative.\n`,
    );
  }
}
