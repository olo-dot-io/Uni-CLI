/**
 * YouTube transcript — retrieve video subtitles/captions.
 *
 * Strategy:
 *   1. Use InnerTube "player" endpoint to get caption track URLs
 *   2. Fetch the timedtext XML from the caption URL
 *   3. Parse XML segments into { start, duration, text } entries
 */

import { USER_AGENT } from "../../constants.js";
import { cli, Strategy } from "../../registry.js";
import { innertubeFetch } from "./innertube.js";

interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  name?: { simpleText?: string };
}

interface PlayerCaptionsResponse {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
    };
  };
}

interface TranscriptSegment {
  start: string;
  duration: string;
  text: string;
}

/** Parse timedtext XML into transcript segments */
function parseTimedTextXml(xml: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const regex =
    /<text\s+start="([^"]*)"(?:\s+dur="([^"]*)")?[^>]*>([\s\S]*?)<\/text>/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(xml)) !== null) {
    const text = (match[3] ?? "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/<[^>]+>/g, "") // strip inline tags like <font>
      .trim();

    if (text) {
      segments.push({
        start: match[1] ?? "0",
        duration: match[2] ?? "0",
        text,
      });
    }
  }

  return segments;
}

cli({
  site: "youtube",
  name: "transcript",
  description: "Get YouTube video transcript/subtitles",
  domain: "www.youtube.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "videoId",
      type: "str",
      required: true,
      positional: true,
      description: "YouTube video ID",
    },
    {
      name: "lang",
      type: "str",
      default: "en",
      description: "Language code (e.g. en, zh, ja)",
    },
  ],
  columns: ["start", "duration", "text"],
  async func(_page, kwargs) {
    const videoId = kwargs.videoId as string;
    const lang = (kwargs.lang as string) ?? "en";

    // Step 1: Get caption tracks from player endpoint
    const playerData = (await innertubeFetch("player", {
      videoId,
    })) as PlayerCaptionsResponse;

    const tracks =
      playerData.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];

    if (tracks.length === 0) {
      throw new Error(`No captions available for video ${videoId}`);
    }

    // Step 2: Find matching language track, fall back to first available
    const track = tracks.find((t) => t.languageCode === lang) ?? tracks[0]!;

    const captionUrl = track.baseUrl;
    if (!captionUrl) {
      throw new Error("Caption track has no URL");
    }

    // Step 3: Fetch timedtext XML
    const resp = await fetch(captionUrl, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!resp.ok) {
      throw new Error(`Failed to fetch captions: ${resp.status}`);
    }
    const xml = await resp.text();

    // Step 4: Parse and return segments
    return parseTimedTextXml(xml);
  },
});
