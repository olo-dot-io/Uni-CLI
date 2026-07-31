/**
 * @owner       src::engine::runtime
 * @does        Executes cancellable per-step retry, diagnostic, and selector recovery helpers.
 * @needs       executor pipeline types, step registry, diagnostic/select-fix modules
 * @feeds       src::engine::executor pipeline orchestration
 * @breaks      Recovery failures remain subordinate to the original pipeline error but are reported on stderr.
 * @invariants  Retries are bounded, cancellation stops unsettled retry/backoff, outcome ambiguity is never replayed, and settled results remain authoritative.
 * @side-effects May retry steps, sleep, emit diagnostics, mutate in-memory pipeline context, and write stderr.
 * @concurrency Each helper call owns its retry counter and pipeline context.
 * @test        tests/unit/engine/runtime-retry.test.ts and pipeline executor suites
 * @stability   stable
 * @since       2026-04-01
 */

import type { PipelineStep } from "../types.js";
import { setTimeout as delay } from "node:timers/promises";
import {
  type PipelineContext,
  PipelineError,
  executeStep,
} from "./executor.js";
import { getStep } from "./step-registry.js";
import { isOperationOutcomeAmbiguousError } from "../transport/contained-process.js";

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

export async function runWithRetry(
  ctx: PipelineContext,
  action: string,
  config: unknown,
  retryCount: number,
  backoffMs: number,
  stepIndex: number,
  step: PipelineStep,
): Promise<PipelineContext> {
  if (retryCount > 0 && !isSafeRetryableRead(ctx, action, config)) {
    throw new PipelineError(
      `Step ${stepIndex} (${action}) declares retry for an operation that is not a proven read-only request.`,
      {
        step: stepIndex,
        action,
        config,
        errorType: "config_error",
        suggestion:
          "Remove retry from the mutating/unknown step. Automatic replay is allowed only for read-only GET/HEAD/OPTIONS fetch operations.",
        retryable: false,
        alternatives: [],
        preserveErrorCode: true,
      },
    );
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    ctx.signal?.throwIfAborted();
    try {
      return await executeStep(ctx, action, config, stepIndex, step);
    } catch (err) {
      if (isOperationOutcomeAmbiguousError(err) || ctx.signal?.aborted) {
        throw err;
      }
      lastErr = err;
      if (!isTypedRetryableReadFailure(err)) throw err;
      if (attempt < retryCount) {
        await delay(backoffMs * Math.pow(2, attempt), undefined, {
          signal: ctx.signal,
        });
      }
    }
  }
  throw lastErr;
}

function isSafeRetryableRead(
  ctx: PipelineContext,
  action: string,
  config: unknown,
): boolean {
  if (ctx.canMutate) return false;
  if (action !== "fetch" && action !== "fetch_text") return false;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return true;
  }
  const method = (config as Record<string, unknown>).method;
  const normalized = typeof method === "string" ? method.toUpperCase() : "GET";
  return new Set(["GET", "HEAD", "OPTIONS"]).has(normalized);
}

function isTypedRetryableReadFailure(error: unknown): boolean {
  return error instanceof PipelineError && error.detail.retryable === true;
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
