import TurndownService from "turndown";
import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";

export function stepHtmlToMd(ctx: PipelineContext): PipelineContext {
  const html = String(ctx.data ?? "");
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  const md = turndown.turndown(html);
  return { ...ctx, data: md };
}

registerStep("html_to_md", stepHtmlToMd as StepHandler);
