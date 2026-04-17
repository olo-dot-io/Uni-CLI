import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";
import { acquirePage } from "./browser-helpers.js";
import { FINGERPRINT_PERSIST_JS } from "../../browser/snapshot-identity.js";

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
  const result = await page.snapshot({
    interactive: opts.interactive,
    compact: opts.compact,
    maxDepth: opts.max_depth,
    raw: opts.raw,
  });
  // Persist the fingerprint map so subsequent click/type steps can verify
  // refs before acting. See src/browser/target-errors.ts.
  try {
    await page.evaluate(FINGERPRINT_PERSIST_JS);
  } catch {
    // Page may have navigated away; stale-ref detection will surface this
    // on the next verified action.
  }
  return { ...ctx, data: result, page };
}

registerStep("snapshot", stepSnapshot as StepHandler);
