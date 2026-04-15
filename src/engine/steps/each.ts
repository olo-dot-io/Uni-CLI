import { registerStep, type StepHandler } from "../step-registry.js";
import {
  type PipelineContext,
  PipelineError,
  executeStep,
  getActionEntry,
} from "../executor.js";
import { buildScope, evalExpression } from "../template.js";
import type { PipelineStep } from "../../types.js";

export interface EachConfig {
  max?: number;
  do: PipelineStep[];
  until?: string;
}

export async function stepEach(
  ctx: PipelineContext,
  config: EachConfig,
  stepIndex: number,
  depth: number,
): Promise<PipelineContext> {
  if (depth > 10) {
    throw new PipelineError("each step recursion depth exceeded (max 10)", {
      step: stepIndex,
      action: "each",
      config,
      errorType: "parse_error",
      suggestion: "Reduce nesting depth of loop steps. Maximum is 10 levels.",
      retryable: false,
      alternatives: [],
    });
  }

  const maxIterations = Math.max(config.max ?? 100, 1);
  const body = config.do;
  if (!body || !Array.isArray(body) || body.length === 0) return ctx;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Reset data at start of each iteration to prevent fetch fan-out
    // from previous iteration's array data. State is carried via ctx.vars.
    ctx = { ...ctx, data: null };

    for (const subStep of body) {
      const [subAction, subConfig] = getActionEntry(subStep);
      ctx = await executeStep(
        ctx,
        subAction,
        subConfig,
        stepIndex,
        subStep,
        depth + 1,
      );
    }

    // Check until condition (after body execution — do-while semantics)
    if (config.until) {
      const condStr =
        typeof config.until === "string" ? config.until : String(config.until);
      const exprMatch = condStr.match(/^\$\{\{\s*(.+?)\s*\}\}$/);
      const expr = exprMatch ? exprMatch[1] : condStr;
      const scope = buildScope(ctx);
      scope.data = ctx.data;
      const result = evalExpression(expr, scope);
      if (result) break;
    }
  }

  return ctx;
}

registerStep("each", (async (ctx, config, stepIndex, _fullStep, depth) => {
  return stepEach(
    ctx as PipelineContext,
    config as EachConfig,
    stepIndex ?? 0,
    depth ?? 0,
  );
}) as StepHandler);
