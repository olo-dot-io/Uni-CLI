import { fileURLToPath } from "node:url";

import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";
import { evalTemplate } from "../template.js";
import { acquirePage, waitForNetworkIdle } from "./browser-helpers.js";
import {
  assertRuntimeNetworkAllowed,
  assertRuntimePathAllowed,
} from "../runtime-resource-guard.js";

export interface NavigateConfig {
  url: string;
  settleMs?: number;
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
}

export async function stepNavigate(
  ctx: PipelineContext,
  config: NavigateConfig,
  stepIndex = -1,
): Promise<PipelineContext> {
  const url = evalTemplate(config.url, ctx);
  const settleMs = config.settleMs ?? 0;
  let parsedUrl: URL | undefined;
  try {
    parsedUrl = new URL(url);
  } catch {
    parsedUrl = undefined;
  }
  if (parsedUrl?.protocol === "file:") {
    assertRuntimePathAllowed(ctx, {
      action: "navigate",
      step: stepIndex,
      config,
      path: fileURLToPath(parsedUrl),
      access: "read",
    });
  } else {
    assertRuntimeNetworkAllowed(ctx, {
      action: "navigate",
      step: stepIndex,
      config,
      url,
      access: "read",
    });
  }

  const page = await acquirePage(ctx);
  await page.goto(url, { settleMs, waitUntil: config.waitUntil });

  if (config.waitUntil === "networkidle") {
    await waitForNetworkIdle(page, 5000, 500);
  }

  return { ...ctx, page };
}

registerStep("navigate", stepNavigate as StepHandler);
