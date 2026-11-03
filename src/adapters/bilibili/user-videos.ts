/**
 * Bilibili user video list adapter — list videos by user mid.
 *
 * Endpoint: /x/space/wbi/arc/search
 */

import { cli, Strategy } from "../../registry.js";
import { wbiFetch } from "./wbi.js";

interface VideoItem {
  title: string;
  play: number;
  like: number;
  created: number;
  bvid: string;
}

interface UserVideosResponse {
  code: number;
  message?: string;
  data?: {
    list?: {
      vlist?: VideoItem[];
    };
  };
}

cli({
  site: "bilibili",
  name: "user-videos",
  description: "List videos published by a Bilibili user",
  domain: "api.bilibili.com",
  strategy: Strategy.COOKIE,
  args: [
    {
      name: "mid",
      required: true,
      positional: true,
      description: "User mid (numeric ID)",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of videos",
    },
  ],
  columns: ["title", "play", "likes", "created", "bvid", "url"],
  func: async (_page, kwargs) => {
    const mid = String(kwargs.mid);
    const limit = Number(kwargs.limit) || 20;

    // The space search answers code -352 (risk control) unless the request carries the browser fingerprint
    // fields the web client sends; empty fingerprints pass (checked 2026-11-03).
    const json = (await wbiFetch(
      "https://api.bilibili.com/x/space/wbi/arc/search",
      {
        mid,
        pn: "1",
        ps: String(limit),
        order: "pubdate",
        dm_img_list: "[]",
        dm_img_str: "V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ",
        dm_cover_img_str: "QU5HTEUgKEFwcGxlLCBBTkdMRSBNZXRhbCBSZW5kZXJlcik",
        dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
      },
    )) as UserVideosResponse;
    if (json.code !== 0 || !json.data?.list) {
      throw Object.assign(
        new Error(
          `Bilibili space search answered code ${json.code}: ${json.message ?? ""}`,
        ),
        {
          code: json.code === -352 ? "rate_limited" : "upstream_error",
          retryable: json.code === -352,
        },
      );
    }

    return (json.data.list.vlist ?? []).map((item) => ({
      title: item.title,
      play: item.play,
      likes: item.like,
      created: new Date(item.created * 1000).toISOString(),
      bvid: item.bvid,
      url: `https://www.bilibili.com/video/${item.bvid}`,
    }));
  },
});
