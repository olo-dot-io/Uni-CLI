/**
 * Bilibili video download URL resolver.
 *
 * Two-step: fetch /x/web-interface/view to get cid,
 * then /x/player/playurl for stream URLs.
 *
 * Does NOT use WBI signing — uses cookie auth directly.
 */

import { cli, Strategy } from "../../registry.js";
import { loadCookies, formatCookieHeader } from "../../engine/cookies.js";
import { USER_AGENT } from "../../constants.js";

interface ViewResponse {
  data: {
    cid: number;
  };
}

interface DashStream {
  id: number;
  bandwidth: number;
  base_url: string;
  codecs: string;
  width: number;
  height: number;
}

interface PlayurlResponse {
  data: {
    quality: number;
    dash?: {
      video: DashStream[];
      audio: Array<{
        id: number;
        bandwidth: number;
        base_url: string;
        codecs: string;
      }>;
    };
    durl?: Array<{
      url: string;
      size: number;
      order: number;
    }>;
  };
}

/** Build authenticated headers for Bilibili API calls. */
function buildHeaders(): Record<string, string> {
  const cookies = loadCookies("bilibili");
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
    Referer: "https://www.bilibili.com",
  };
  if (cookies) headers["Cookie"] = formatCookieHeader(cookies);
  return headers;
}

cli({
  site: "bilibili",
  name: "download",
  description: "Get download URLs for a Bilibili video",
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
  columns: ["type", "quality", "codecs", "size", "url"],
  func: async (_page, kwargs) => {
    const bvid = String(kwargs.bvid);
    const headers = buildHeaders();

    // Step 1: resolve cid from bvid
    const viewResp = await fetch(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
      { headers },
    );
    if (!viewResp.ok) {
      throw new Error(`Failed to resolve bvid ${bvid}: ${viewResp.status}`);
    }
    const viewJson = (await viewResp.json()) as ViewResponse;
    const cid = viewJson.data.cid;

    // Step 2: get playurl with DASH format (fnval=16) and highest quality (qn=116)
    const playResp = await fetch(
      `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&qn=116&fnval=16`,
      { headers },
    );
    if (!playResp.ok) {
      throw new Error(
        `Failed to fetch playurl: ${playResp.status} ${playResp.statusText}`,
      );
    }
    const playJson = (await playResp.json()) as PlayurlResponse;

    const results: Array<{
      type: string;
      quality: number;
      codecs: string;
      size: number;
      url: string;
    }> = [];

    // DASH format streams
    if (playJson.data.dash) {
      for (const v of playJson.data.dash.video) {
        results.push({
          type: "video",
          quality: v.id,
          codecs: v.codecs,
          size: v.bandwidth,
          url: v.base_url,
        });
      }
      for (const a of playJson.data.dash.audio) {
        results.push({
          type: "audio",
          quality: a.id,
          codecs: a.codecs,
          size: a.bandwidth,
          url: a.base_url,
        });
      }
    }

    // Legacy durl format (fallback)
    if (playJson.data.durl) {
      for (const d of playJson.data.durl) {
        results.push({
          type: "flv",
          quality: playJson.data.quality,
          codecs: "unknown",
          size: d.size,
          url: d.url,
        });
      }
    }

    return results;
  },
});
