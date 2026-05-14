/**
 * @owner   src/adapters/zhihu/recommend.ts
 * @does    Register paginated Zhihu home recommendation reader.
 * @needs   Logged-in Zhihu browser session, topstory recommendation API, bounded page traversal.
 * @feeds   surface coverage ledger, Zhihu discovery workflows, reference parity checks.
 * @breaks  Zhihu recommendation API paging or target shape drift can block feed extraction.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";

const MAX_RECOMMEND_LIMIT = 1000;

interface ZhihuRecommendItem {
  id?: unknown;
  type?: unknown;
  target?: {
    id?: unknown;
    type?: unknown;
    title?: unknown;
    question?: { id?: unknown; title?: unknown };
    author?: { name?: unknown };
    voteup_count?: unknown;
    reaction?: { statistics?: { like_count?: unknown } };
  };
}

interface ZhihuRecommendPage {
  data?: ZhihuRecommendItem[];
  paging?: {
    is_end?: unknown;
    next?: unknown;
  };
}

interface BrowserFetchResult {
  ok: boolean;
  status: number;
  text: string;
}

function stringField(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function countField(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function pageOf(page: unknown): IPage {
  if (!page) throw new Error("Zhihu recommend requires a browser page.");
  return page as IPage;
}

export function parseZhihuRecommendLimit(value: unknown): number {
  const n = value === undefined || value === null ? 20 : Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_RECOMMEND_LIMIT) {
    throw new Error(
      `Zhihu recommend limit must be a positive integer no greater than ${MAX_RECOMMEND_LIMIT}.`,
    );
  }
  return n;
}

export function zhihuRecommendItemKey(item: ZhihuRecommendItem): string {
  const target = item.target ?? {};
  if (target.id !== undefined && target.id !== null) {
    return `${stringField(target.type)}:${stringField(target.id)}`;
  }
  if (item.id !== undefined && item.id !== null) {
    return `feed:${stringField(item.id)}`;
  }
  return "";
}

export function normalizeZhihuRecommendTitle(item: ZhihuRecommendItem): string {
  const target = item.target ?? {};
  if (target.type === "answer") return stringField(target.question?.title);
  return stringField(target.title || target.question?.title);
}

export function normalizeZhihuRecommendUrl(item: ZhihuRecommendItem): string {
  const target = item.target ?? {};
  const id = stringField(target.id);
  if (target.type === "answer") {
    const questionId = stringField(target.question?.id);
    return questionId && id
      ? `https://www.zhihu.com/question/${questionId}/answer/${id}`
      : "";
  }
  if (target.type === "article") {
    return id ? `https://zhuanlan.zhihu.com/p/${id}` : "";
  }
  if (target.type === "question") {
    return id ? `https://www.zhihu.com/question/${id}` : "";
  }
  return "";
}

export function mapZhihuRecommendItem(
  item: ZhihuRecommendItem,
  rank: number,
): Record<string, unknown> {
  const target = item.target ?? {};
  return {
    rank,
    type: stringField(target.type || item.type),
    title: normalizeZhihuRecommendTitle(item),
    author: stringField(target.author?.name),
    votes: countField(
      target.voteup_count ?? target.reaction?.statistics?.like_count,
    ),
    url: normalizeZhihuRecommendUrl(item),
  };
}

async function browserFetchRecommend(
  page: IPage,
  url: string,
): Promise<ZhihuRecommendPage> {
  const raw = await page.evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(url)}, {
      credentials: "include",
      headers: { Accept: "application/json" }
    });
    const text = await response.text();
    return JSON.stringify({ ok: response.ok, status: response.status, text });
  })()`);
  const result = JSON.parse(stringField(raw)) as BrowserFetchResult;
  if (!result.ok) {
    if (result.status === 401 || result.status === 403) {
      throw new Error(
        `Zhihu recommend requires Zhihu cookies (HTTP ${result.status}).`,
      );
    }
    throw new Error(`Zhihu recommend request failed (HTTP ${result.status}).`);
  }
  try {
    return JSON.parse(result.text) as ZhihuRecommendPage;
  } catch (err) {
    throw new Error(
      `Zhihu recommend returned malformed JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function collectZhihuRecommendations(
  page: IPage,
  limit: number,
): Promise<ZhihuRecommendItem[]> {
  const items: ZhihuRecommendItem[] = [];
  const seen = new Set<string>();
  const visited = new Set<string>();
  let url =
    "https://www.zhihu.com/api/v3/feed/topstory/recommend?limit=10&desktop=true";
  while (url && items.length < limit && !visited.has(url)) {
    visited.add(url);
    const data = await browserFetchRecommend(page, url);
    const rows = Array.isArray(data.data) ? data.data : [];
    for (const item of rows) {
      const key = zhihuRecommendItemKey(item);
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      items.push(item);
      if (items.length >= limit) break;
    }
    if (data.paging?.is_end) break;
    url = typeof data.paging?.next === "string" ? data.paging.next : "";
  }
  if (items.length === 0) {
    throw new Error("No Zhihu recommendations returned.");
  }
  return items;
}

cli({
  site: "zhihu",
  name: "recommend",
  description: "知乎首页推荐",
  domain: "www.zhihu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "limit",
      type: "int",
      default: 20,
      description:
        "Number of items to return (max 1000; use normal-sized requests)",
    },
  ],
  columns: ["rank", "type", "title", "author", "votes", "url"],
  func: async (page, kwargs) => {
    const browser = pageOf(page);
    const limit = parseZhihuRecommendLimit(kwargs.limit);
    await browser.goto("https://www.zhihu.com");
    const items = await collectZhihuRecommendations(browser, limit);
    return items
      .slice(0, limit)
      .map((item, index) => mapZhihuRecommendItem(item, index + 1));
  },
});
