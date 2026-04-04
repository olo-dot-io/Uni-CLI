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
  data: {
    list: {
      vlist: VideoItem[];
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
  columns: ["title", "play", "likes", "created", "bvid"],
  func: async (_page, kwargs) => {
    const mid = String(kwargs.mid);
    const limit = Number(kwargs.limit) || 20;

    const json = (await wbiFetch(
      "https://api.bilibili.com/x/space/wbi/arc/search",
      {
        mid,
        pn: "1",
        ps: String(limit),
        order: "pubdate",
      },
    )) as UserVideosResponse;

    return (json.data.list.vlist ?? []).map((item) => ({
      title: item.title,
      play: item.play,
      likes: item.like,
      created: item.created,
      bvid: item.bvid,
    }));
  },
});
