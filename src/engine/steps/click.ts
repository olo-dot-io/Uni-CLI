/**
 * @owner       src::engine::steps::click
 * @does        Execute one selector/ref or explicit coordinate click through the page's trusted input boundary.
 * @needs       pipeline executor/template, browser page acquisition
 * @feeds       engine step registry
 * @breaks      Missing selectors/coordinates and page target/input failures remain typed pipeline errors.
 * @invariants  Ref selectors are resolved and hit-tested inside page.click; coordinate input remains an explicit caller-selected route with no selector fallback.
 * @side-effects Dispatches one browser pointer mutation.
 * @perf        One page command after template expansion; no duplicate preflight renderer lookup.
 * @test        tests/unit/browser-steps.test.ts, tests/unit/browser-page.test.ts
 * @stability   stable
 * @since       2026-04-15
 */

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

  // Coordinate-click bypasses ref verification — deliberate fallback for
  // cases where snapshot refs are unusable (e.g. canvas/WebGL targets,
  // drag handles, or pixel-precise recordings).
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
