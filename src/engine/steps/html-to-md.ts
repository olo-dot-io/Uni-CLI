/**
 * @owner       src::engine::steps::html-to-md
 * @does        Rejects high-confidence browser-verification pages, then applies the shared content-focused HTML-to-Markdown conversion to pipeline data.
 * @needs       src/engine/html-to-markdown.ts, pipeline context, step registry
 * @feeds       web.read and adapter pipelines using html_to_md
 * @breaks      Divergent conversion or challenge-page false success makes direct extraction and adapter reads disagree.
 * @invariants  High-confidence verification pages fail closed; successful conversion preserves pipeline context fields other than data.
 * @side-effects Registers the html_to_md step at module load.
 * @test        tests/unit/engine-features.test.ts
 * @stability   stable
 * @since       2026-07-17
 */

import { registerStep, type StepHandler } from "../step-registry.js";
import { PipelineError, type PipelineContext } from "../executor.js";
import { htmlToMarkdown } from "../html-to-markdown.js";

import { isHtmlVerificationChallenge } from "../http-response.js";
export { isHtmlVerificationChallenge } from "../http-response.js";

export function stepHtmlToMd(
  ctx: PipelineContext,
  _config: unknown,
  stepIndex = -1,
): PipelineContext {
  const html = String(ctx.data ?? "");
  if (isHtmlVerificationChallenge(html)) {
    throw new PipelineError(
      "HTML conversion stopped because the upstream returned a browser-verification challenge instead of document content.",
      {
        step: stepIndex,
        action: "html_to_md",
        config: {},
        errorType: "challenge_required",
        suggestion:
          "Complete the upstream verification in the shared browser session or use a registered source-specific API.",
        retryable: false,
        alternatives: [],
        preserveErrorCode: true,
      },
    );
  }
  const md = htmlToMarkdown(html);
  return { ...ctx, data: md };
}

registerStep("html_to_md", stepHtmlToMd as StepHandler);
