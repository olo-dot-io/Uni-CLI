/**
 * @owner   yt-dlp subtitle adapter.
 * @does    Extracts subtitle files from any yt-dlp-supported video URL.
 * @needs   Local yt-dlp binary and optional browser cookies for private or rate-limited videos.
 * @feeds   Unified social video-text workflows across YouTube, Bilibili, TikTok, Douyin, X, Instagram, and other sites.
 * @breaks  Returns an error when yt-dlp cannot produce subtitle files for the requested URL and languages.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cli, Strategy } from "../../registry.js";
import { extractVideoSubtitles } from "../../social/video-text.js";

function parseLanguages(raw: unknown): string[] {
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

cli({
  site: "yt-dlp",
  name: "subtitles",
  description:
    "Extract subtitles from any yt-dlp-supported video URL with optional browser-cookie reuse",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "url",
      type: "str",
      required: true,
      positional: true,
      description: "Video URL",
      format: "uri",
    },
    {
      name: "languages",
      type: "str",
      default: "zh-Hans,zh,en",
      description: "Comma-separated subtitle languages",
    },
    {
      name: "cookies-from-browser",
      type: "str",
      description: "Browser name for yt-dlp --cookies-from-browser",
    },
  ],
  columns: ["path", "language"],
  socialCapabilities: ["read", "media", "subtitles"],
  func: async (_page, kwargs) => {
    const url = String(kwargs.url ?? "");
    const dir = mkdtempSync(join(tmpdir(), "unicli-subtitles-"));
    return extractVideoSubtitles({
      url,
      outputTemplate: join(dir, "%(id)s.%(ext)s"),
      languages: parseLanguages(kwargs.languages),
      cookiesFromBrowser: kwargs["cookies-from-browser"]
        ? String(kwargs["cookies-from-browser"])
        : undefined,
    });
  },
});
