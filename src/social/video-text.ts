/**
 * @owner   Social video text extraction.
 * @does    Builds and runs yt-dlp subtitle extraction with optional browser-cookie reuse.
 * @needs   `yt-dlp` on PATH and a caller-provided output template.
 * @feeds   Cross-platform subtitle adapters and video download workflows.
 * @breaks  Upstream yt-dlp extractor changes can alter generated subtitle filenames.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface YtdlpSubtitleArgsOptions {
  url: string;
  outputTemplate: string;
  languages?: string[];
  cookiesFromBrowser?: string;
}

export interface ExtractVideoSubtitlesOptions extends YtdlpSubtitleArgsOptions {
  timeoutMs?: number;
}

export interface ExtractedSubtitleFile {
  path: string;
  language: string;
}

export function buildYtdlpSubtitleArgs(
  options: YtdlpSubtitleArgsOptions,
): string[] {
  const url = options.url.trim();
  if (!url) throw new Error("url is required");
  const outputTemplate = options.outputTemplate.trim();
  if (!outputTemplate) throw new Error("outputTemplate is required");
  const languages = options.languages ?? ["zh-Hans", "zh", "en"];
  if (languages.length === 0) {
    throw new Error("at least one subtitle language is required");
  }

  const args = [
    "--skip-download",
    "--write-sub",
    "--write-auto-sub",
    "--sub-lang",
    languages.join(","),
    "--sub-format",
    "vtt/best",
    "--convert-subs",
    "vtt",
  ];

  if (options.cookiesFromBrowser) {
    args.push("--cookies-from-browser", options.cookiesFromBrowser);
  }

  args.push("-o", outputTemplate, url);
  return args;
}

function languageFromSubtitlePath(path: string): string {
  const parts = path.split(".");
  return parts.length >= 3 ? parts[parts.length - 2] : "";
}

export async function extractVideoSubtitles(
  options: ExtractVideoSubtitlesOptions,
): Promise<ExtractedSubtitleFile[]> {
  const dir = dirname(options.outputTemplate);
  mkdirSync(dir, { recursive: true });
  const before = new Set(existsSync(dir) ? readdirSync(dir) : []);
  const args = buildYtdlpSubtitleArgs(options);

  await execFileAsync("yt-dlp", args, {
    timeout: options.timeoutMs ?? 5 * 60 * 1000,
  });

  const after = readdirSync(dir);
  const files = after
    .filter((name) => !before.has(name) && name.endsWith(".vtt"))
    .sort()
    .map((name) => ({
      path: `${dir}/${name}`,
      language: languageFromSubtitlePath(name),
    }));

  if (files.length === 0) {
    throw new Error("yt-dlp did not produce any VTT subtitle files");
  }

  return files;
}
