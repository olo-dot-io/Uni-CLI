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
  // page.snapshot() persists the fingerprint map so subsequent click/type
  // steps can verify refs. See src/browser/snapshot-helpers.ts.
  const result = await page.snapshot({
    interactive: opts.interactive,
    compact: opts.compact,
    maxDepth: opts.max_depth,
    raw: opts.raw,
  });
  return { ...ctx, data: result, page };
}

registerStep("snapshot", stepSnapshot as StepHandler);
