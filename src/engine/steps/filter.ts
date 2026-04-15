import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";
import { evalExpression } from "../template.js";

export function stepFilter(
  ctx: PipelineContext,
  expr: string,
): PipelineContext {
  if (!Array.isArray(ctx.data)) return ctx;

  const items = ctx.data as unknown[];
  const filtered = items.filter((item, index) => {
    const result = evalExpression(expr, { item, index, args: ctx.args });
    return Boolean(result);
  });

  return { ...ctx, data: filtered };
}

registerStep("filter", stepFilter as StepHandler);
