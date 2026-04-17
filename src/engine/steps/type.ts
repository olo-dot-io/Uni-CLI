import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";
import { evalTemplate } from "../template.js";
import { acquirePage } from "./browser-helpers.js";
import { verifyRef } from "../../browser/snapshot-identity.js";

export interface TypeConfig {
  text: string;
  selector?: string;
  submit?: boolean;
}

export async function stepType(
  ctx: PipelineContext,
  config: TypeConfig,
): Promise<PipelineContext> {
  const page = await acquirePage(ctx);
  const text = evalTemplate(config.text, ctx);
  if (config.selector) {
    const selector = evalTemplate(config.selector, ctx);
    await verifyRef(page, selector);
    await page.type(selector, text);
  } else {
    // No selector — type into currently focused element via CDP
    await page.sendCDP("Input.insertText", { text });
  }
  if (config.submit) await page.press("Enter");
  return { ...ctx, page };
}

registerStep("type", stepType as StepHandler);
