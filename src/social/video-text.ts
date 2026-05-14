/**
 * @owner   Social video text extraction.
 * @does    Builds and runs yt-dlp subtitle extraction with optional browser-cookie reuse.
 * @needs   `yt-dlp` on PATH and a caller-provided output template.
 * @feeds   Cross-platform subtitle adapters and video download workflows.
 * @breaks  Upstream yt-dlp extractor changes can alter generated subtitle filenames.
 */

import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  text: string;
}

export function parseSubtitleLanguages(raw: unknown): string[] {
  const value = String(raw ?? "zh-Hans,zh,en");
  const languages = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (languages.length === 0) {
    throw new Error("at least one subtitle language is required");
  }
  return languages;
}

export function buildYtdlpSubtitleArgs(
  options: YtdlpSubtitleArgsOptions,
): string[] {
  const url = options.url.trim();
  if (!url) throw new Error("url is required");
  const outputTemplate = options.outputTemplate.trim();
  if (!outputTemplate) throw new Error("outputTemplate is required");
  const languages = options.languages
    ? options.languages.map((item) => item.trim()).filter(Boolean)
    : parseSubtitleLanguages(undefined);
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

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function parseVttPlainText(vtt: string): string {
  const output: string[] = [];
  const lines = vtt.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let skipBlock = false;
  let seenCueTiming = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]?.trim() ?? "";
    if (!line) {
      skipBlock = false;
      continue;
    }
    if (skipBlock) continue;
    if (line.startsWith("WEBVTT")) continue;
    if (line.includes("-->")) {
      seenCueTiming = true;
      continue;
    }
    if (/^(NOTE|STYLE|REGION)(\s|$)/.test(line)) {
      skipBlock = true;
      continue;
    }
    if ((lines[index + 1] ?? "").includes("-->")) continue;
    if (!seenCueTiming) continue;

    const cleaned = decodeHtmlEntities(line.replace(/<[^>]*>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned || output[output.length - 1] === cleaned) continue;
    output.push(cleaned);
  }

  return output.join("\n");
}

export async function runVideoSubtitleExtraction(
  kwargs: Record<string, unknown>,
): Promise<ExtractedSubtitleFile[]> {
  const url = String(kwargs.url ?? "");
  const dir = mkdtempSync(join(tmpdir(), "unicli-subtitles-"));
  return extractVideoSubtitles({
    url,
    outputTemplate: join(dir, "%(id)s.%(ext)s"),
    languages: parseSubtitleLanguages(kwargs.languages),
    cookiesFromBrowser: kwargs["cookies-from-browser"]
      ? String(kwargs["cookies-from-browser"])
      : undefined,
  });
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
      path: join(dir, name),
      language: languageFromSubtitlePath(name),
      text: parseVttPlainText(readFileSync(join(dir, name), "utf-8")),
    }));

  if (files.length === 0) {
    throw new Error("yt-dlp did not produce any VTT subtitle files");
  }

  return files;
}
