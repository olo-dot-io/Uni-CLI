/**
 * @owner       src::engine::steps::rate-limit
 * @does        Registers the rate_limit pipeline action and maps invalid configuration to a structured parse error.
 * @needs       step registry, executor PipelineError, rate limiter
 * @feeds       built-in registered pipeline surface
 * @breaks      Missing domain or invalid RPM fails before scheduling a token wait.
 * @invariants  Configuration is an object with a non-empty domain and optional integer RPM in 1..60000.
 * @side-effects May await the process-local rate limiter.
 * @perf        O(1) handler overhead plus intentional token wait.
 * @concurrency Shared per-domain bucket semantics are owned by rate-limiter.ts.
 * @test        tests/unit/pipeline-loops.test.ts, tests/unit/step-surface.test.ts
 * @stability   stable
 * @since       2026-07-12
 */

import { PipelineError, type PipelineContext } from "../executor.js";
import { waitForToken } from "../rate-limiter.js";
import { registerStep, type StepHandler } from "../step-registry.js";

export interface RateLimitConfig {
  domain: string;
  rpm?: number;
}

export async function stepRateLimit(
  ctx: PipelineContext,
  config: unknown,
  stepIndex: number = 0,
): Promise<PipelineContext> {
  const parsed =
    config && typeof config === "object" && !Array.isArray(config)
      ? (config as Partial<RateLimitConfig>)
      : {};
  const domain = typeof parsed.domain === "string" ? parsed.domain : "";
  const rpm = parsed.rpm ?? 60;
  try {
    await waitForToken(domain, rpm);
  } catch (error) {
    throw new PipelineError(
      error instanceof Error ? error.message : String(error),
      {
        step: stepIndex,
        action: "rate_limit",
        config,
        errorType: "parse_error",
        suggestion:
          "Set rate_limit.domain to a non-empty host and rpm to an integer from 1 to 60000.",
        retryable: false,
      },
    );
  }
  return ctx;
}

registerStep("rate_limit", stepRateLimit as StepHandler);
