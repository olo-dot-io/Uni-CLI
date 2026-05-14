/**
 * @owner   Instagram subtitle adapter.
 * @does    Extracts LLM-readable subtitle text from public Instagram reel and video URLs.
 * @needs   `yt-dlp` on PATH and an accessible video subtitle track.
 * @feeds   Cross-platform social video analysis workflows.
 * @breaks  Instagram or yt-dlp extractor changes can alter subtitle availability.
 */

import { cli, Strategy } from "../../registry.js";
import { runVideoSubtitleExtraction } from "../../social/video-text.js";

cli({
  site: "instagram",
  name: "subtitles",
  description:
    "Extract LLM-readable subtitles from an Instagram reel or video URL with optional browser-cookie reuse",
  domain: "www.instagram.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "url",
      type: "str",
      required: true,
      positional: true,
      description: "Instagram reel or video URL",
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
  columns: ["language", "text", "path"],
  socialCapabilities: ["read", "media", "subtitles"],
  defaultFormat: "json",
  func: async (_page, kwargs) => runVideoSubtitleExtraction(kwargs),
});
