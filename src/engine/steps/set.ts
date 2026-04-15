import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";
import { resolveTemplateDeep } from "../template.js";

export function stepSet(
  ctx: PipelineContext,
  config: Record<string, unknown>,
): PipelineContext {
  if (!config || typeof config !== "object" || Array.isArray(config))
    return ctx;
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    resolved[key] = resolveTemplateDeep(value, ctx);
  }
  return { ...ctx, vars: { ...ctx.vars, ...resolved } };
}

registerStep("set", stepSet as StepHandler);
