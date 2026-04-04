/**
 * Bilibili video subtitle extractor.
 *
 * Uses /x/player/wbi/v2 to get subtitle metadata,
 * then fetches the actual subtitle JSON file.
 */

import { cli, Strategy } from "../../registry.js";
import { wbiFetch } from "./wbi.js";

interface SubtitleInfo {
  subtitle_url: string;
}

interface PlayerResponse {
  data: {
    subtitle: {
      subtitles: SubtitleInfo[];
    };
  };
}

interface SubtitleEntry {
  from: number;
  to: number;
  content: string;
}

interface SubtitleFile {
  body: SubtitleEntry[];
}

cli({
  site: "bilibili",
  name: "subtitle",
  description: "Extract subtitles from a Bilibili video",
  domain: "api.bilibili.com",
  strategy: Strategy.COOKIE,
  args: [
    {
      name: "bvid",
      required: true,
      positional: true,
      description: "Video bvid (e.g. BV1xx...)",
    },
  ],
  columns: ["from", "to", "content"],
  func: async (_page, kwargs) => {
    const bvid = String(kwargs.bvid);

    const playerJson = (await wbiFetch(
      "https://api.bilibili.com/x/player/wbi/v2",
      { bvid },
    )) as PlayerResponse;

    const subtitles = playerJson.data.subtitle.subtitles;
    if (!subtitles || subtitles.length === 0) {
      return [];
    }

    // Use the first available subtitle track
    let subtitleUrl = subtitles[0].subtitle_url;
    // Bilibili sometimes returns protocol-relative URLs
    if (subtitleUrl.startsWith("//")) {
      subtitleUrl = "https:" + subtitleUrl;
    }

    const resp = await fetch(subtitleUrl);
    if (!resp.ok) {
      throw new Error(
        `Failed to fetch subtitle file: ${resp.status} ${resp.statusText}`,
      );
    }
    const subtitleData = (await resp.json()) as SubtitleFile;

    return (subtitleData.body ?? []).map((entry) => ({
      from: entry.from,
      to: entry.to,
      content: entry.content,
    }));
  },
});
