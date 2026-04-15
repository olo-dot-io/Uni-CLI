import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";
import { evalTemplate } from "../template.js";

export function stepLimit(
  ctx: PipelineContext,
  config: unknown,
): PipelineContext {
  if (!Array.isArray(ctx.data)) return ctx;

  let n: number;
  if (typeof config === "number") {
    n = config;
  } else {
    const val = evalTemplate(String(config), ctx);
    n = parseInt(val, 10) || 20;
  }

  return { ...ctx, data: ctx.data.slice(0, n) };
}

registerStep("limit", stepLimit as StepHandler);
