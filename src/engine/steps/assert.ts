import { registerStep, type StepHandler } from "../step-registry.js";
import { type PipelineContext, PipelineError } from "../executor.js";
import { evalExpression, evalTemplate } from "../template.js";

export interface AssertConfig {
  url?: string;
  selector?: string;
  text?: string;
  condition?: string;
  message?: string;
}

export async function stepAssert(
  ctx: PipelineContext,
  config: AssertConfig,
  stepIndex: number,
): Promise<PipelineContext> {
  const page = ctx.page ? ctx.page : undefined;

  if (config.url) {
    if (!page)
      throw assertionError(
        "url assertion requires a browser page",
        config,
        stepIndex,
      );
    const currentUrl = await page.url();
    const expected = evalTemplate(config.url, ctx);
    if (!currentUrl.includes(expected)) {
      throw assertionError(
        `URL mismatch: expected "${expected}" in "${currentUrl}"`,
        config,
        stepIndex,
      );
    }
  }

  if (config.selector) {
    if (!page)
      throw assertionError(
        "selector assertion requires a browser page",
        config,
        stepIndex,
      );
    const selector = evalTemplate(config.selector, ctx);
    const exists = await page.evaluate(
      `!!document.querySelector(${JSON.stringify(selector)})`,
    );
    if (!exists) {
      throw assertionError(`Element not found: ${selector}`, config, stepIndex);
    }
  }

  if (config.text) {
    if (!page)
      throw assertionError(
        "text assertion requires a browser page",
        config,
        stepIndex,
      );
    const expected = evalTemplate(config.text, ctx);
    const bodyText = (await page.evaluate(
      "document.body?.innerText || ''",
    )) as string;
    if (!bodyText.includes(expected)) {
      throw assertionError(`Text not found: "${expected}"`, config, stepIndex);
    }
  }

  if (config.condition) {
    const expr = evalTemplate(config.condition, ctx);
    const result = evalExpression(expr, {
      data: ctx.data,
      args: ctx.args,
      vars: ctx.vars,
    });
    if (!result) {
      throw assertionError(`Condition failed: ${expr}`, config, stepIndex);
    }
  }

  return ctx;
}

function assertionError(
  message: string,
  config: AssertConfig,
  stepIndex: number,
): PipelineError {
  return new PipelineError(config.message ?? message, {
    step: stepIndex,
    action: "assert",
    config,
    errorType: "assertion_failed",
    suggestion:
      "Check the assertion conditions in the adapter YAML. The page state may not match expectations.",
    retryable: false,
    alternatives: [],
  });
}

registerStep("assert", stepAssert as StepHandler);
