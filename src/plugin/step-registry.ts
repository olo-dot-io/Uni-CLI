/**
 * Plugin Step Registry — allows third-party plugins to register custom
 * pipeline steps that the YAML runner can execute.
 *
 * Usage from a plugin's main entry point:
 *   import { registerStep } from "unicli/plugin/step-registry";
 *   registerStep("my_step", async (ctx, config) => { ... return ctx; });
 */

/** Pipeline context exposed to plugin step handlers. */
export interface PluginPipelineContext {
  data: unknown;
  args: Record<string, unknown>;
  vars: Record<string, unknown>;
  base?: string;
  cookieHeader?: string;
}

export type StepHandler = (
  ctx: PluginPipelineContext,
  config: unknown,
) => Promise<PluginPipelineContext>;

const customSteps = new Map<string, StepHandler>();

/**
 * Register a custom pipeline step.
 * If a step with the same name already exists it is overwritten with a warning.
 */
export function registerStep(name: string, handler: StepHandler): void {
  if (customSteps.has(name)) {
    console.warn(`[plugin] step "${name}" already registered, overwriting`);
  }
  customSteps.set(name, handler);
}

/** Retrieve a previously registered custom step handler. */
export function getCustomStep(name: string): StepHandler | undefined {
  return customSteps.get(name);
}

/** List all registered custom step names. */
export function listCustomSteps(): string[] {
  return [...customSteps.keys()];
}

/** Remove a custom step (used mainly in tests). */
export function unregisterStep(name: string): boolean {
  return customSteps.delete(name);
}
