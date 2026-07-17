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

export function isHtmlVerificationChallenge(html: string): boolean {
  const normalized = html.replaceAll(/\s+/g, " ").toLowerCase();
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? "";
  const verificationHeading = /(?:verifying|checking) your browser/i.test(
    `${title} ${heading}`,
  );
  const verificationInstructions =
    /enable javascript and cookies|complete the check|security verification|performing security verification/.test(
      normalized,
    );
  return (
    (normalized.length <= 12_000 &&
      verificationHeading &&
      verificationInstructions) ||
    (/just a moment/.test(normalized) &&
      /enable javascript and cookies|complete the check/.test(normalized)) ||
    /(?:cf-chl-|challenge-platform|cf-turnstile)/.test(normalized)
  );
}

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
