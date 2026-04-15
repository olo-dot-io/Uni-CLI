import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";
import { evalTemplate } from "../template.js";

export function stepMap(
  ctx: PipelineContext,
  template: Record<string, string>,
): PipelineContext {
  if (!Array.isArray(ctx.data)) return ctx;

  const items = ctx.data as unknown[];
  const mapped = items.map((item, index) => {
    const row: Record<string, unknown> = {};
    for (const [key, expr] of Object.entries(template)) {
      row[key] = evalTemplate(String(expr), {
        ...ctx,
        data: { item, index },
      });
    }
    return row;
  });

  return { ...ctx, data: mapped };
}

registerStep("map", stepMap as StepHandler);
