import { registerStep, type StepHandler } from "../step-registry.js";
import {
  type PipelineContext,
  PipelineError,
  executeStep,
  getActionEntry,
} from "../executor.js";
import { mapConcurrent } from "../download.js";
import type { PipelineStep } from "../../types.js";

export async function stepParallel(
  ctx: PipelineContext,
  branches: PipelineStep[],
  merge: string,
  stepIndex: number,
  depth: number,
): Promise<PipelineContext> {
  if (!Array.isArray(branches) || branches.length === 0) return ctx;

  if (depth > 10) {
    throw new PipelineError("parallel step recursion depth exceeded (max 10)", {
      step: stepIndex,
      action: "parallel",
      config: branches,
      errorType: "parse_error",
      suggestion:
        "Reduce nesting depth of parallel steps. Maximum is 10 levels.",
      retryable: false,
      alternatives: [],
    });
  }

  // Parallel concurrency cap — bound simultaneous branch execution so a
  // pipeline with 100 parallel `fetch` steps doesn't exhaust the socket
  // pool or trip per-host rate limiters. Default 5 mirrors `stepFetch`
  // fan-out.
  const results = await mapConcurrent(branches, 5, async (branch) => {
    const branchCtx: PipelineContext = {
      ...ctx,
      vars: { ...ctx.vars },
    };
    const [action, config] = getActionEntry(branch);
    const result = await executeStep(
      branchCtx,
      action,
      config,
      stepIndex,
      branch,
      depth + 1,
    );
    return result.data;
  });

  let merged: unknown;
  switch (merge) {
    case "zip": {
      const first = results[0];
      if (Array.isArray(first)) {
        merged = first.map((_, i) =>
          results.map((r) => (Array.isArray(r) ? r[i] : r)),
        );
      } else {
        merged = results;
      }
      break;
    }
    case "object":
      merged = Object.fromEntries(results.map((r, i) => [String(i), r]));
      break;
    case "concat":
    default:
      merged = results.flatMap((r) => (Array.isArray(r) ? r : [r]));
      break;
  }

  return { ...ctx, data: merged };
}

registerStep("parallel", (async (ctx, config, stepIndex, fullStep, depth) => {
  const mergeStrategy =
    ((fullStep as Record<string, unknown> | undefined)?.merge as string) ??
    "concat";
  return stepParallel(
    ctx as PipelineContext,
    config as PipelineStep[],
    mergeStrategy,
    stepIndex ?? 0,
    depth ?? 0,
  );
}) as StepHandler);
