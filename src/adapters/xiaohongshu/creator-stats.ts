/**
 * Xiaohongshu Creator Analytics — account-level metrics overview.
 *
 * Uses the creator.xiaohongshu.com internal API (cookie auth).
 * Returns 7-day and 30-day aggregate stats: views, likes, collects,
 * comments, shares, new followers, and daily trend data.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";

cli({
  site: "xiaohongshu",
  name: "creator-stats",
  description:
    "Xiaohongshu creator analytics overview (views/likes/collects/comments/shares/followers + daily trend)",
  domain: "creator.xiaohongshu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "period",
      default: "seven",
      description: "Stats period: seven or thirty",
      choices: ["seven", "thirty"],
    },
  ],
  columns: ["metric", "total", "trend"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const period: string = String(kwargs.period || "seven");

    await p.goto("https://creator.xiaohongshu.com/new/home");

    const data = (await p.evaluate(`
      async () => {
        try {
          const resp = await fetch('/api/galaxy/creator/data/note_detail_new', {
            credentials: 'include',
          });
          if (!resp.ok) return { error: 'HTTP ' + resp.status };
          return await resp.json();
        } catch (e) {
          return { error: e.message };
        }
      }
    `)) as Record<string, unknown>;

    if (data?.error) {
      throw new Error(
        `${data.error}. Are you logged into creator.xiaohongshu.com?`,
      );
    }

    const allData = (data?.data ?? {}) as Record<string, unknown>;
    if (!allData) {
      throw new Error("Unexpected response structure");
    }

    const stats = allData[period] as Record<string, unknown> | undefined;
    if (!stats) {
      throw new Error(
        `No data for period "${period}". Available: ${Object.keys(allData).join(", ")}`,
      );
    }

    const formatTrend = (list: unknown): string => {
      if (!Array.isArray(list) || !list.length) return "-";
      return list
        .map((d: Record<string, unknown>) => d.count)
        .join(" -> ");
    };

    return [
      {
        metric: "views",
        total: stats.view_count ?? 0,
        trend: formatTrend(stats.view_list),
      },
      {
        metric: "avg_view_time_ms",
        total: stats.view_time_avg ?? 0,
        trend: formatTrend(stats.view_time_list),
      },
      {
        metric: "home_views",
        total: stats.home_view_count ?? 0,
        trend: formatTrend(stats.home_view_list),
      },
      {
        metric: "likes",
        total: stats.like_count ?? 0,
        trend: formatTrend(stats.like_list),
      },
      {
        metric: "collects",
        total: stats.collect_count ?? 0,
        trend: formatTrend(stats.collect_list),
      },
      {
        metric: "comments",
        total: stats.comment_count ?? 0,
        trend: formatTrend(stats.comment_list),
      },
      { metric: "danmaku", total: stats.danmaku_count ?? 0, trend: "-" },
      {
        metric: "shares",
        total: stats.share_count ?? 0,
        trend: formatTrend(stats.share_list),
      },
      {
        metric: "new_followers",
        total: stats.rise_fans_count ?? 0,
        trend: formatTrend(stats.rise_fans_list),
      },
    ];
  },
});
