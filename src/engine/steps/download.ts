/**
 * @owner       src::engine::steps::download
 * @does        Downloads one or many validated resources to policy-approved paths with bounded concurrency and caller cancellation.
 * @needs       transactional HTTP/yt-dlp download primitives, SSRF and runtime resource guards, templates, and filesystem metadata
 * @feeds       pipeline action "download" and artifact-producing adapters
 * @breaks      Missing cancellation, path/network validation, or atomic publication can leak work past deadlines or corrupt prior artifacts.
 * @invariants  Initial URLs and runtime resources are validated before I/O; HTTP redirects revalidate at the download primitive; caller abort reaches HTTP streams and yt-dlp; output rows retain explicit status.
 * @side-effects Creates output directories and files and may execute yt-dlp.
 * @perf        Fan-out uses caller-bounded concurrency; yt-dlp defaults to a five-minute process timeout.
 * @concurrency Each destination has one worker; caller cancellation is shared by the invocation.
 * @test        tests/unit/engine/steps/download-cancellation.test.ts
 * @stability   stable
 * @since       2026-04-03
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";
import { evalTemplate } from "../template.js";
import { assertSafeRequestUrl } from "../ssrf.js";
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
  headers?: Record<string, string>;
  concurrency?: number;
  skip_existing?: boolean;
  use_ytdlp?: boolean;
  cookies_from_browser?: string;
  type?: "auto" | "image" | "video" | "document";
  content?: string;
}

export async function stepDownload(
  ctx: PipelineContext,
  config: DownloadStepConfig,
  stepIndex = -1,
): Promise<PipelineContext> {
  const dirTemplate = config.dir ?? "./downloads";
  const concurrency = config.concurrency ?? 3;
  const skipExisting = config.skip_existing !== false; // default true
  const cookieHeader = ctx.cookieHeader;
  const readyDirs = new Set<string>();

  function ensureDirectoryReady(dir: string): void {
    if (readyDirs.has(dir)) return;
    mkdirSync(dir, { recursive: true });
    readyDirs.add(dir);
  }

  async function downloadOne(
    item: Record<string, unknown>,
    index: number,
  ): Promise<Record<string, unknown>> {
    ctx.signal?.throwIfAborted();
    const itemCtx: PipelineContext = { ...ctx, data: { item, index } };
    const url = evalTemplate(config.url, itemCtx);
    const dir = resolve(evalTemplate(dirTemplate, itemCtx));
    const filename = config.filename
      ? evalTemplate(config.filename, itemCtx)
      : generateFilename(url, index);
    const destPath = join(dir, sanitizeFilename(filename));

    assertSafeRequestUrl(url);
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

    ensureDirectoryReady(dir);

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
      result = await ytdlpDownload(url, dir, {
        cookiesFromBrowser: config.cookies_from_browser,
        signal: ctx.signal,
      });
    } else {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(config.headers ?? {})) {
        headers[key] = evalTemplate(String(value), itemCtx);
      }
      if (cookieHeader) headers["Cookie"] = cookieHeader;
      result = await httpDownload(url, destPath, {
        headers,
        signal: ctx.signal,
        validateRequest: (redirectUrl) =>
          assertRuntimeNetworkAllowed(ctx, {
            action: "download",
            step: stepIndex,
            config,
            url: redirectUrl,
            access: "read",
          }),
      });
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
