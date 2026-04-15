import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";
import { evalTemplate } from "../template.js";
import { acquirePage } from "./browser-helpers.js";

export interface EvaluateConfig {
  expression: string;
}

export async function stepEvaluate(
  ctx: PipelineContext,
  config: EvaluateConfig | string,
): Promise<PipelineContext> {
  const page = await acquirePage(ctx);
  const expr =
    typeof config === "string"
      ? evalTemplate(config, ctx)
      : evalTemplate(config.expression, ctx);
  const result = await page.evaluate(expr);
  return { ...ctx, data: result, page };
}

registerStep("evaluate", stepEvaluate as StepHandler);
