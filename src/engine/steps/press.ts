import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";
import { evalTemplate } from "../template.js";
import { acquirePage } from "./browser-helpers.js";

export async function stepPress(
  ctx: PipelineContext,
  config: unknown,
): Promise<PipelineContext> {
  const page = await acquirePage(ctx);
  if (typeof config === "string") {
    await page.press(evalTemplate(config, ctx));
  } else {
    const cfg = config as { key: string; modifiers?: string[] };
    const key = evalTemplate(cfg.key, ctx);
    if (cfg.modifiers && cfg.modifiers.length > 0) {
      await page.nativeKeyPress(key, cfg.modifiers);
    } else {
      await page.press(key);
    }
  }
  return { ...ctx, page };
}

registerStep("press", stepPress as StepHandler);
