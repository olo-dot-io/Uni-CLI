import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";
import { evalTemplate } from "../template.js";
import { acquirePage } from "./browser-helpers.js";

export async function stepScroll(
  ctx: PipelineContext,
  config: unknown,
): Promise<PipelineContext> {
  const page = await acquirePage(ctx);
  if (typeof config === "string") {
    await page.scroll(config as "down" | "up" | "bottom" | "top");
  } else {
    const cfg = config as {
      to?: string;
      selector?: string;
      auto?: boolean;
      max?: number;
      delay?: number;
    };
    if (cfg.auto) {
      await page.autoScroll({ maxScrolls: cfg.max, delay: cfg.delay });
    } else if (cfg.selector) {
      const sel = evalTemplate(cfg.selector, ctx);
      const escaped = sel.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      await page.evaluate(
        `document.querySelector('${escaped}')?.scrollIntoView({ behavior: 'smooth', block: 'center' })`,
      );
    } else if (cfg.to) {
      await page.scroll(cfg.to as "down" | "up" | "bottom" | "top");
    }
  }
  return { ...ctx, page };
}

registerStep("scroll", stepScroll as StepHandler);
