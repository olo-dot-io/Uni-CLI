import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";

const HOME = "https://linux.do";

function limitOf(value: unknown): number {
  const n = Number(value ?? 20);
  if (!Number.isFinite(n)) return 20;
  return Math.max(1, Math.min(100, Math.trunc(n)));
}

async function fetchLinuxDoJson(
  page: IPage,
  path: string,
): Promise<Record<string, unknown>> {
  await page.goto(HOME, { settleMs: 1500 });
  const result = (await page.evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(path)}, {
      credentials: "include",
      headers: { accept: "application/json" }
    });
    let data = null;
    try { data = await response.json(); } catch {}
    return {
      ok: response.ok,
      status: response.status,
      data,
      error: data === null ? "Response is not valid JSON" : ""
    };
  })()`)) as {
    ok?: boolean;
    status?: number;
    data?: Record<string, unknown>;
    error?: string;
  };

  if (result.status === 401 || result.status === 403) {
    throw new Error("Authentication required for linux-do");
  }
  if (!result.ok) {
    throw new Error(
      result.error ||
        `linux-do request failed: HTTP ${result.status ?? "unknown"}`,
    );
  }
  return result.data ?? {};
}

cli({
  site: "linux-do",
  name: "search",
  description: "Search Linux.do forum topics",
  domain: "linux.do",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "Search query",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of results",
    },
  ],
  columns: ["rank", "title", "views", "likes", "replies", "url"],
  func: async (page, kwargs) => {
    const query = String(kwargs.query ?? "");
    const limit = limitOf(kwargs.limit);
    const data = await fetchLinuxDoJson(
      page as IPage,
      `/search.json?q=${encodeURIComponent(query)}`,
    );
    const topics = Array.isArray(data.topics) ? data.topics : [];
    return topics.slice(0, limit).map((topic, index) => {
      const item = topic as Record<string, unknown>;
      return {
        rank: index + 1,
        title: String(item.title ?? ""),
        views: Number(item.views ?? 0),
        likes: Number(item.like_count ?? 0),
        replies: Number(item.posts_count ?? 1) - 1,
        url: `https://linux.do/t/topic/${String(item.id ?? "")}`,
      };
    });
  },
});
