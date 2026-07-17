/**
 * @owner       src::engine::steps::html-to-md
 * @does        Applies the shared content-focused HTML-to-Markdown conversion to pipeline data.
 * @needs       src/engine/html-to-markdown.ts, pipeline context, step registry
 * @feeds       web.read and adapter pipelines using html_to_md
 * @breaks      Divergent conversion here makes direct extraction and adapter reads disagree.
 * @invariants  Preserves pipeline context fields other than data.
 * @side-effects Registers the html_to_md step at module load.
 * @test        tests/unit/engine-features.test.ts
 * @stability   stable
 * @since       2026-07-17
 */

import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";
import { htmlToMarkdown } from "../html-to-markdown.js";

export function stepHtmlToMd(ctx: PipelineContext): PipelineContext {
  const html = String(ctx.data ?? "");
  const md = htmlToMarkdown(html);
  return { ...ctx, data: md };
}

registerStep("html_to_md", stepHtmlToMd as StepHandler);
