import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";
import { acquirePage } from "./browser-helpers.js";

export interface WaitBrowserConfig {
  ms?: number;
  selector?: string;
  timeout?: number;
}

export async function stepWaitBrowser(
  ctx: PipelineContext,
  config: WaitBrowserConfig | number,
): Promise<PipelineContext> {
  const page = await acquirePage(ctx);
  if (typeof config === "number") {
    await page.waitFor(config);
  } else if (config.selector) {
    await page.waitFor(config.selector, config.timeout ?? 10000);
  } else if (config.ms) {
    await page.waitFor(config.ms);
  }
  return { ...ctx, page };
}

registerStep("wait", stepWaitBrowser as StepHandler);
