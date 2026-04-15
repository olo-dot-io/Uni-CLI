import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";
import { acquirePage } from "./browser-helpers.js";

export async function stepSnapshot(
  ctx: PipelineContext,
  config: unknown,
): Promise<PipelineContext> {
  const page = await acquirePage(ctx);
  const opts =
    typeof config === "object" && config !== null
      ? (config as {
          interactive?: boolean;
          compact?: boolean;
          max_depth?: number;
          raw?: boolean;
        })
      : {};
  // Normalize max_depth to maxDepth for BrowserPage.snapshot
  const normalizedOpts = {
    interactive: opts.interactive,
    compact: opts.compact,
    maxDepth: opts.max_depth,
    raw: opts.raw,
  };
  const result = await page.snapshot(normalizedOpts);
  return { ...ctx, data: result, page };
}

registerStep("snapshot", stepSnapshot as StepHandler);
