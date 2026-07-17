/**
 * @owner       src::adapters::bilibili::search
 * @does        Searches Bilibili videos through its WBI-signed search API.
 * @needs       Current WBI keys and the Bilibili video search response.
 * @feeds       Bilibili workflows and opt-in registry-driven Chinese AI video intelligence.
 * @breaks      WBI signing or response drift surfaces as an explicit adapter error.
 * @invariants  Every returned video carries a canonical Bilibili URL and source timestamp when supplied.
 * @side-effects Authenticated HTTPS read only.
 * @perf        Maps one bounded search page.
 * @concurrency safe across invocations.
 * @test        Bilibili adapter tests and tests/unit/commands/ai.test.ts
 * @stability   experimental
 * @since       2026-07-17
 */

import { cli, Strategy } from "../../registry.js";
import { wbiFetch } from "./wbi.js";

interface SearchResult {
  title: string;
  author: string;
  play: number;
  bvid: string;
  description: string;
  published_at: number;
  url: string;
}

interface SearchResponse {
  data: {
    result: Array<{
      title: string;
      author: string;
      play: number;
      bvid: string;
      description?: string;
      pubdate?: number;
    }>;
  };
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

cli({
  site: "bilibili",
  name: "search",
  description: "Search Bilibili videos by keyword",
  domain: "api.bilibili.com",
  strategy: Strategy.COOKIE,
  args: [
    {
      name: "keyword",
      required: true,
      positional: true,
      description: "Search keyword",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of results",
    },
  ],
  columns: ["rank", "title", "author", "play", "published_at", "bvid", "url"],
  capabilities: ["http.fetch", "ai.search", "ai.community", "ai.video"],
  func: async (_page, kwargs) => {
    const keyword = String(kwargs.keyword);
    const limit = Number(kwargs.limit) || 20;

    const json = (await wbiFetch(
      "https://api.bilibili.com/x/web-interface/wbi/search/type",
      {
        search_type: "video",
        keyword,
        page: "1",
        page_size: String(limit),
      },
    )) as SearchResponse;

    const results: Array<SearchResult & { rank: number }> = (
      json.data.result ?? []
    ).map((item, idx) => ({
      rank: idx + 1,
      title: stripHtml(item.title),
      author: item.author,
      play: item.play,
      bvid: item.bvid,
      description: stripHtml(item.description ?? ""),
      published_at: item.pubdate ?? 0,
      url: `https://www.bilibili.com/video/${item.bvid}`,
    }));

    return results.slice(0, limit);
  },
});
