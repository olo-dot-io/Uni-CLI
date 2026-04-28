import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";
import { evalTemplate } from "../template.js";
import {
  assertRuntimeNetworkAllowed,
  assertRuntimePathAllowed,
} from "../runtime-resource-guard.js";
import {
  type DownloadResult,
  httpDownload,
  ytdlpDownload,
  requiresYtdlp,
  sanitizeFilename,
  generateFilename,
  mapConcurrent,
} from "../download.js";

export interface DownloadStepConfig {
  url: string;
  dir?: string;
  filename?: string;
  concurrency?: number;
  skip_existing?: boolean;
  use_ytdlp?: boolean;
  type?: "auto" | "image" | "video" | "document";
  content?: string;
}

export async function stepDownload(
  ctx: PipelineContext,
  config: DownloadStepConfig,
  stepIndex = -1,
): Promise<PipelineContext> {
  const dir = resolve(config.dir ?? "./downloads");
  const concurrency = config.concurrency ?? 3;
  const skipExisting = config.skip_existing !== false; // default true
  const cookieHeader = ctx.cookieHeader;

  async function downloadOne(
    item: Record<string, unknown>,
    index: number,
  ): Promise<Record<string, unknown>> {
    const itemCtx: PipelineContext = { ...ctx, data: { item, index } };
    const url = evalTemplate(config.url, itemCtx);
    const filename = config.filename
      ? evalTemplate(config.filename, itemCtx)
      : generateFilename(url, index);
    const destPath = join(dir, sanitizeFilename(filename));

    assertRuntimePathAllowed(ctx, {
      action: "download",
      step: stepIndex,
      config,
      path: destPath,
      access: "write",
    });
    assertRuntimeNetworkAllowed(ctx, {
      action: "download",
      step: stepIndex,
      config,
      url,
      access: "read",
    });

    mkdirSync(dir, { recursive: true });

    if (skipExisting && existsSync(destPath)) {
      return { ...item, _download: { status: "skipped", path: destPath } };
    }

    const useYtdlp =
      config.use_ytdlp ?? (config.type === "video" && requiresYtdlp(url));

    let result: DownloadResult;
    if (config.type === "document" && config.content) {
      const content = evalTemplate(config.content, itemCtx);
      writeFileSync(destPath, content, "utf-8");
      const info = await stat(destPath);
      result = {
        status: "success",
        path: destPath,
        size: info.size,
        duration: 0,
      };
    } else if (useYtdlp) {
      result = await ytdlpDownload(url, dir);
    } else {
      const headers: Record<string, string> = {};
      if (cookieHeader) headers["Cookie"] = cookieHeader;
      result = await httpDownload(url, destPath, headers);
    }

    return { ...item, _download: result };
  }

  if (Array.isArray(ctx.data)) {
    const items = ctx.data as Record<string, unknown>[];
    const results = await mapConcurrent(items, concurrency, downloadOne);
    return { ...ctx, data: results };
  } else {
    const item = (ctx.data ?? {}) as Record<string, unknown>;
    const result = await downloadOne(item, 0);
    return { ...ctx, data: [result] };
  }
}

registerStep("download", stepDownload as StepHandler);
