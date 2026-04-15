/**
 * Example Uni-CLI plugin — registers a `reverse` pipeline step.
 *
 * Install alongside @zenalexa/unicli, then preload with:
 *   node --import @zenalexa/unicli-plugin-example $(which unicli) ...
 *
 * Or from a custom host script:
 *   import "@zenalexa/unicli-plugin-example";
 *   import { runPipeline } from "@zenalexa/unicli/engine";
 */

import { registerStep } from "@zenalexa/unicli/engine/registry";
import type { PipelineContext } from "@zenalexa/unicli/engine";

registerStep("reverse", async (ctx: PipelineContext, _config: unknown) => {
  return {
    ...ctx,
    data: Array.isArray(ctx.data) ? [...ctx.data].reverse() : ctx.data,
  };
});
