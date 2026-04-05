/**
 * Douyin stats — per-video analytics from the creator center.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { browserFetch } from "./_shared/browser-fetch.js";

cli({
  site: "douyin",
  name: "stats",
  description: "Get Douyin video analytics (7-day metrics trend)",
  domain: "creator.douyin.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "aweme_id",
      required: true,
      positional: true,
      description: "Video aweme_id",
    },
  ],
  columns: ["metric", "value"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const now = Math.floor(Date.now() / 1000);
    const sevenDaysAgo = now - 7 * 86400;
    const url =
      "https://creator.douyin.com/janus/douyin/creator/data/item_analysis/metrics_trend";
    const body = {
      aweme_id: kwargs.aweme_id as string,
      start_time: sevenDaysAgo,
      end_time: now,
      metrics: ["play_count", "like_count", "comment_count", "share_count"],
    };
    const res = (await browserFetch(p, "POST", url, { body })) as {
      data: Record<string, number>;
    };
    const data = res.data ?? {};
    return Object.entries(data).map(([metric, value]) => ({ metric, value }));
  },
});
