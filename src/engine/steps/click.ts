import { registerStep, type StepHandler } from "../step-registry.js";
import { type PipelineContext, PipelineError } from "../executor.js";
import { evalTemplate } from "../template.js";
import { acquirePage } from "./browser-helpers.js";

export interface ClickConfig {
  selector?: string;
  x?: number;
  y?: number;
  quads?: boolean;
}

export async function stepClick(
  ctx: PipelineContext,
  config: ClickConfig | string,
): Promise<PipelineContext> {
  const page = await acquirePage(ctx);

  if (typeof config === "string") {
    const selector = evalTemplate(config, ctx);
    await page.click(selector);
    return { ...ctx, page };
  }

  if (config.x !== undefined && config.y !== undefined) {
    await page.nativeClick(config.x, config.y);
    return { ...ctx, page };
  }

  if (config.selector) {
    const selector = evalTemplate(config.selector, ctx);
    await page.click(selector);
    return { ...ctx, page };
  }

  throw new PipelineError(
    "click step requires either selector or x/y coordinates",
    {
      step: -1,
      action: "click",
      config,
      errorType: "expression_error",
      suggestion:
        'Provide either a CSS selector string, {selector: "..."}, or {x: N, y: N} for coordinate click.',
      retryable: false,
      alternatives: [],
    },
  );
}

registerStep("click", stepClick as StepHandler);
