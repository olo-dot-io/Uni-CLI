/**
 * Pipeline step registry — the capability table the executor dispatches
 * through.
 *
 * Each per-step module self-registers on import. `steps/index.ts` is the
 * aggregator that triggers every registration; the executor imports that
 * barrel once, then `getStep(name)` works for every built-in action.
 */

import type { PipelineStep } from "../types.js";
import type { PipelineContext } from "./executor.js";

export type StepHandler<TConfig = unknown> = (
  ctx: PipelineContext,
  config: TConfig,
  stepIndex?: number,
  fullStep?: PipelineStep,
  depth?: number,
) => Promise<PipelineContext> | PipelineContext;

const registry = new Map<string, StepHandler>();

export function registerStep<TConfig = unknown>(
  name: string,
  handler: StepHandler<TConfig>,
): void {
  if (registry.has(name)) {
    throw new Error(`step "${name}" already registered`);
  }
  registry.set(name, handler as StepHandler);
}

export function getStep(name: string): StepHandler | undefined {
  return registry.get(name);
}

export function listSteps(): string[] {
  return Array.from(registry.keys()).sort();
}

export function unregisterStep(name: string): boolean {
  return registry.delete(name);
}
