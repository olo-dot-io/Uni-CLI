/**
 * @owner   Xiaohongshu trend extraction.
 * @does    Reads trending searches, falling back to visible hot notes in Chrome.
 * @needs   A logged-in Xiaohongshu browser session or valid local cookies.
 * @feeds   Agents needing current XHS trend context without brittle API-only failure.
 * @breaks  XHS endpoint and DOM drift can reduce rows; command returns only observed public UI data.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { socialEmptyError } from "../../social/browser-errors.js";
import { assertXhsReadable, fetchXhsFeedItems } from "./browser-state.js";

interface TrendRow {
  rank: number;
  keyword: string;
  score: string;
  url: string;
}

async function fetchHotList(page: IPage, limit: number): Promise<TrendRow[]> {
  const raw = await page.evaluate(`
    (async () => {
      const limit = ${limit};
      const resp = await fetch('/api/sns/v1/search/hot_list', {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });
      if (!resp.ok) return { ok: false, status: resp.status };
      const data = await resp.json();
      const items = data?.data?.items || data?.data || [];
      return {
        ok: true,
        rows: items.slice(0, limit).map((item, i) => {
          const keyword = item.title || item.name || item.word || '';
          return {
            rank: i + 1,
            keyword,
            score: String(item.score || item.hot_value || ''),
            url: 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(keyword),
          };
        }).filter((item) => item.keyword)
      };
    })()
  `);
  const result = raw as { ok?: boolean; rows?: TrendRow[] };
  return result.ok && Array.isArray(result.rows) ? result.rows : [];
}

async function fetchHotFeed(page: IPage, limit: number): Promise<TrendRow[]> {
  const items = await fetchXhsFeedItems(page);
  const rows = items
    .map((item) => item as Record<string, unknown>)
    .map((item) => {
      const note = item.note_card as Record<string, unknown> | undefined;
      const interact = note?.interact_info as
        | Record<string, unknown>
        | undefined;
      return {
        title: String(note?.display_title ?? ""),
        likes: String(interact?.liked_count ?? ""),
        id: String(item.id ?? ""),
      };
    })
    .filter((item) => item.title && item.id)
    .sort((a, b) => Number(b.likes || 0) - Number(a.likes || 0))
    .slice(0, limit);
  return rows.map((item, i) => ({
    rank: i + 1,
    keyword: item.title,
    score: item.likes,
    url: `https://www.xiaohongshu.com/explore/${item.id}`,
  }));
}

cli({
  site: "xiaohongshu",
  name: "trending",
  description: "Xiaohongshu trending searches and visible hot notes",
  domain: "www.xiaohongshu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  browserSession: "user",
  args: [
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of trending topics",
    },
  ],
  columns: ["rank", "keyword", "score", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const limit = Number(kwargs.limit) || 20;
    await p.goto("https://www.xiaohongshu.com/explore", { settleMs: 2500 });
    await p.wait(2);
    await assertXhsReadable(p, "trending");

    const hotList = await fetchHotList(p, limit);
    if (hotList.length > 0) return hotList;

    const hotFeed = await fetchHotFeed(p, limit);
    if (hotFeed.length > 0) return hotFeed;

    throw socialEmptyError(
      "xiaohongshu",
      "trending",
      "Xiaohongshu explore loaded no parseable hot-search or hot-note rows.",
    );
  },
});
