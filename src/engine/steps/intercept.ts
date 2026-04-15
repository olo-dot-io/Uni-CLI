import { registerStep, type StepHandler } from "../step-registry.js";
import { type PipelineContext, PipelineError } from "../executor.js";
import { evalTemplate } from "../template.js";
import { acquirePage } from "./browser-helpers.js";
import {
  generateInterceptorJs,
  generateReadInterceptedJs,
} from "../interceptor.js";

export interface InterceptConfig {
  trigger: string;
  capture: string;
  select?: string;
  timeout?: number;
  regex?: boolean;
  all?: boolean;
  captureText?: boolean;
}

export async function stepIntercept(
  ctx: PipelineContext,
  config: InterceptConfig,
): Promise<PipelineContext> {
  const page = await acquirePage(ctx);
  const capturePattern = evalTemplate(config.capture, ctx);
  const timeout = config.timeout ?? 10000;

  // Install interceptor: patch fetch + XHR to capture matching responses
  await page.evaluate(
    generateInterceptorJs(capturePattern, {
      regex: config.regex,
      captureAll: config.all,
      captureText: config.captureText,
    }),
  );

  const trigger = evalTemplate(config.trigger, ctx);
  if (trigger.startsWith("navigate:")) {
    await page.goto(trigger.slice(9), { settleMs: 2000 });
  } else if (trigger.startsWith("click:")) {
    await page.click(trigger.slice(6));
  } else if (trigger === "scroll") {
    await page.scroll("down");
  } else if (trigger.startsWith("evaluate:")) {
    await page.evaluate(trigger.slice(9));
  }

  // Poll for captured response
  const startTime = Date.now();
  let captured: unknown = null;
  while (Date.now() - startTime < timeout) {
    const result = await page.evaluate(generateReadInterceptedJs());
    const arr = JSON.parse(result as string) as Array<{
      url: string;
      data: unknown;
      type?: string;
    }>;
    if (arr.length > 0) {
      if (config.all) {
        captured = arr.map((item) => item.data);
      } else {
        captured = arr[arr.length - 1].data;
      }
      break;
    }
    await page.waitFor(200);
  }

  if (!captured) {
    throw new PipelineError(
      `Intercept timeout: no request matching "${capturePattern}" captured within ${String(timeout)}ms`,
      {
        step: -1,
        action: "intercept",
        config: { capture: capturePattern, trigger },
        errorType: "timeout",
        suggestion: `No network request matching "${capturePattern}" was observed. Verify the capture pattern matches the target API URL and that the trigger action causes the request.`,
        retryable: true,
        alternatives: [],
      },
    );
  }

  let data: unknown = captured;
  if (config.select) {
    const segments = config.select.split(".");
    for (const key of segments) {
      if (data !== null && data !== undefined && typeof data === "object") {
        data = (data as Record<string, unknown>)[key];
      }
    }
  }

  return { ...ctx, data, page };
}

registerStep("intercept", stepIntercept as StepHandler);
