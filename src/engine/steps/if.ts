import { registerStep, type StepHandler } from "../step-registry.js";
import {
  type PipelineContext,
  PipelineError,
  executeStep,
  getActionEntry,
} from "../executor.js";
import { buildScope, evalExpression } from "../template.js";
import type { PipelineStep } from "../../types.js";

export async function stepIf(
  ctx: PipelineContext,
  config: { if: string; then?: PipelineStep[]; else?: PipelineStep[] },
  stepIndex: number,
  depth: number = 0,
): Promise<PipelineContext> {
  if (depth > 10) {
    throw new PipelineError("if step recursion depth exceeded (max 10)", {
      step: stepIndex,
      action: "if",
      config,
      errorType: "parse_error",
      suggestion:
        "Reduce nesting depth of if/else steps. Maximum is 10 levels.",
      retryable: false,
      alternatives: [],
    });
  }

  const conditionStr =
    typeof config.if === "string" ? config.if : String(config.if);

  // Strip ${{ }} wrapper if present
  const exprMatch = conditionStr.match(/^\$\{\{\s*(.+?)\s*\}\}$/);
  const expr = exprMatch ? exprMatch[1] : conditionStr;
  const result = evalExpression(expr, buildScope(ctx));

  const branch = result ? config.then : config.else;
  if (!branch || !Array.isArray(branch) || branch.length === 0) return ctx;

  for (let j = 0; j < branch.length; j++) {
    const subStep = branch[j];
    const [subAction, subConfig] = getActionEntry(subStep);
    ctx = await executeStep(
      ctx,
      subAction,
      subConfig,
      stepIndex,
      subStep,
      depth,
    );
  }
  return ctx;
}

// stepIf needs the full step object to read .then/.else.
registerStep("if", (async (ctx, config, stepIndex, fullStep, depth) => {
  const ifStep = (fullStep ?? { if: config }) as {
    if: string;
    then?: PipelineStep[];
    else?: PipelineStep[];
  };
  return stepIf(
    ctx as PipelineContext,
    ifStep,
    stepIndex ?? 0,
    (depth ?? 0) + 1,
  );
}) as StepHandler);
