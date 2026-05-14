/**
 * @owner   Facebook subtitle adapter.
 * @does    Extracts LLM-readable subtitle text from public Facebook video URLs.
 * @needs   `yt-dlp` on PATH and an accessible video subtitle track.
 * @feeds   Social video evidence gathering without browser-security bypasses.
 * @breaks  Facebook or yt-dlp extractor changes can alter subtitle availability.
 */

import { cli, Strategy } from "../../registry.js";
import { runVideoSubtitleExtraction } from "../../social/video-text.js";

cli({
  site: "facebook",
  name: "subtitles",
  description:
    "Extract LLM-readable subtitles from a Facebook video URL with optional browser-cookie reuse",
  domain: "www.facebook.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "url",
      type: "str",
      required: true,
      positional: true,
      description: "Facebook video URL",
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
