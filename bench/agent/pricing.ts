/**
 * Pricing table for the multi-model bench runner.
 *
 * Prices in USD per 1M tokens (matches OpenRouter's display format).
 * Unknown models use PRICING_FALLBACK. These numbers drive both the
 * pre-flight cost estimator and the actual-cost accumulator (since the
 * OpenAI-compatible response may not include total_cost_usd directly).
 */

export interface Pricing {
  /** USD per 1M input tokens. */
  in: number;
  /** USD per 1M output tokens. */
  out: number;
}

export const PRICING: Readonly<Record<string, Pricing>> = Object.freeze({
  "deepseek/deepseek-chat": { in: 0.27, out: 1.1 },
  "anthropic/claude-haiku-4-5": { in: 0.25, out: 1.25 },
  "openai/gpt-5-mini": { in: 0.25, out: 2.0 },
});

/** Conservative fallback used when a user-supplied model isn't in PRICING. */
export const PRICING_FALLBACK: Pricing = Object.freeze({ in: 1.0, out: 3.0 });

export const DEFAULT_MODELS: readonly string[] = Object.freeze([
  "deepseek/deepseek-chat",
  "anthropic/claude-haiku-4-5",
  "openai/gpt-5-mini",
]);

/**
 * Estimate USD cost of a trial batch at `estIn`/`estOut` tokens per trial.
 * Uses the pricing table; unknown models fall back to PRICING_FALLBACK.
 */
export function estimateCostUsd(
  modelId: string,
  nTrials: number,
  estIn: number,
  estOut: number,
): number {
  const price = PRICING[modelId] ?? PRICING_FALLBACK;
  return (
    (nTrials * estIn * price.in) / 1_000_000 +
    (nTrials * estOut * price.out) / 1_000_000
  );
}
