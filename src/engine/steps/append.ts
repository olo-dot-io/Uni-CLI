import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";

export function stepAppend(ctx: PipelineContext, key: string): PipelineContext {
  if (typeof key !== "string" || !key) return ctx;
  const existing = ctx.vars[key];
  const arr = Array.isArray(existing)
    ? [...existing]
    : existing !== undefined
      ? [existing]
      : [];
  if (Array.isArray(ctx.data)) {
    arr.push(...(ctx.data as unknown[]));
  } else if (ctx.data !== null && ctx.data !== undefined) {
    arr.push(ctx.data);
  }
  return { ...ctx, vars: { ...ctx.vars, [key]: arr } };
}

registerStep("append", stepAppend as StepHandler);
