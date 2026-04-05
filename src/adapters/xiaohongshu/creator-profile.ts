/**
 * Xiaohongshu Creator Profile — creator account info and growth status.
 *
 * Uses the creator.xiaohongshu.com internal API (cookie auth).
 * Returns follower/following counts, total likes+collects, and
 * creator level growth info.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";

cli({
  site: "xiaohongshu",
  name: "creator-profile",
  description: "Xiaohongshu creator account info (followers/following/likes/level)",
  domain: "creator.xiaohongshu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [],
  columns: ["field", "value"],
  func: async (page, _kwargs) => {
    const p = page as IPage;
    await p.goto("https://creator.xiaohongshu.com/new/home");

    const data = (await p.evaluate(`
      async () => {
        try {
          const resp = await fetch('/api/galaxy/creator/home/personal_info', {
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

    const d = (data?.data ?? {}) as Record<string, unknown>;
    if (!d || typeof d !== "object") {
      throw new Error("Unexpected response structure");
    }

    const grow = (d.grow_info ?? {}) as Record<string, unknown>;

    return [
      { field: "Name", value: String(d.name ?? "") },
      { field: "Followers", value: String(d.fans_count ?? 0) },
      { field: "Following", value: String(d.follow_count ?? 0) },
      { field: "Likes & Collects", value: String(d.faved_count ?? 0) },
      { field: "Creator Level", value: String(grow.level ?? 0) },
      {
        field: "Level Progress",
        value: `${grow.fans_count ?? 0}/${grow.max_fans_count ?? 0} fans`,
      },
      {
        field: "Bio",
        value: String(d.personal_desc ?? "").replace(/\n/g, " | "),
      },
    ];
  },
});
