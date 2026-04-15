import { registerStep, type StepHandler } from "../step-registry.js";
import { type PipelineContext, PipelineError } from "../executor.js";
import { evalTemplate, getNestedValue } from "../template.js";

export function stepSelect(
  ctx: PipelineContext,
  path: string,
  stepIndex: number,
): PipelineContext {
  const resolved = evalTemplate(path, ctx);
  const data = getNestedValue(ctx.data, resolved);
  if (data === undefined || data === null) {
    throw new PipelineError(
      `Select "${resolved}" returned nothing — the response structure may have changed`,
      {
        step: stepIndex,
        action: "select",
        config: path,
        errorType: "selector_miss",
        suggestion: `The path "${resolved}" does not exist in the API response. Inspect the actual response JSON to find the correct path, then update the "select" step in the adapter YAML.`,
        retryable: false,
        alternatives: [],
      },
    );
  }
  return { ...ctx, data };
}

registerStep("select", stepSelect as StepHandler);
