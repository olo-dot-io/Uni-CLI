/**
 * @owner       src::engine::steps::type
 * @does        Type bounded templated text into one selector/ref or the already-focused browser element and optionally submit.
 * @needs       pipeline executor/template, browser page acquisition
 * @feeds       engine step registry
 * @breaks      Page target, ref trust, input, and submit failures propagate without DOM-write fallback.
 * @invariants  Selector focus and text insertion share page.type's serialized command; selector-free input is explicit CDP insertion.
 * @side-effects Dispatches browser keyboard/text mutations.
 * @perf        One page command for selector typing plus one optional submit command; no duplicate ref preflight.
 * @test        tests/unit/browser-steps.test.ts, tests/unit/browser-page.test.ts
 * @stability   stable
 * @since       2026-04-15
 */

import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";
import { evalTemplate } from "../template.js";
import { acquirePage } from "./browser-helpers.js";

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
    await page.type(selector, text);
  } else {
    // No selector — type into currently focused element via CDP
    await page.sendCDP("Input.insertText", { text });
  }
  if (config.submit) await page.press("Enter");
  return { ...ctx, page };
}

registerStep("type", stepType as StepHandler);
