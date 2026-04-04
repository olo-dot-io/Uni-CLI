/**
 * Bilibili video search adapter — WBI-signed keyword search.
 *
 * Endpoint: /x/web-interface/wbi/search/type
 */

import { cli, Strategy } from "../../registry.js";
import { wbiFetch } from "./wbi.js";

interface SearchResult {
  title: string;
  author: string;
  play: number;
  bvid: string;
}

interface SearchResponse {
  data: {
    result: Array<{
      title: string;
      author: string;
      play: number;
      bvid: string;
    }>;
  };
}

/** Strip HTML tags from Bilibili search result titles. */
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
  columns: ["rank", "title", "author", "play", "bvid"],
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
    }));

    return results.slice(0, limit);
  },
});
