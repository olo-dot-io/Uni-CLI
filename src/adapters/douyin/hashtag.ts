/**
 * Douyin hashtag — search, AI-suggest, and hot topics from the creator center.
 *
 * Three actions:
 *   - search: keyword-based hashtag lookup
 *   - suggest: AI-recommended hashtags (optionally based on a cover image URI)
 *   - hot: trending hotspot words
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { browserFetch } from "./_shared/browser-fetch.js";

cli({
  site: "douyin",
  name: "hashtag",
  description: "Search, suggest, or list hot Douyin hashtags",
  domain: "creator.douyin.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "action",
      required: true,
      positional: true,
      description:
        "search=keyword search, suggest=AI recommend, hot=trending hotspot words",
    },
    {
      name: "keyword",
      default: "",
      description: "Search keyword (for search/hot actions)",
    },
    {
      name: "cover",
      default: "",
      description: "Cover URI (for suggest action)",
    },
    { name: "limit", type: "int", default: 10, description: "Max results" },
  ],
  columns: ["name", "id", "view_count"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const action = kwargs.action as string;
    const limit = Number(kwargs.limit) || 10;

    if (action === "search") {
      const keyword = encodeURIComponent(String(kwargs.keyword ?? ""));
      const url = `https://creator.douyin.com/aweme/v1/challenge/search/?keyword=${keyword}&count=${limit}&aid=1128`;
      const res = (await browserFetch(p, "GET", url)) as {
        challenge_list: Array<{
          challenge_info: {
            cid: string;
            cha_name: string;
            view_count: number;
          };
        }>;
      };
      return (res.challenge_list ?? []).map((c) => ({
        name: c.challenge_info.cha_name,
        id: c.challenge_info.cid,
        view_count: c.challenge_info.view_count,
      }));
    }

    if (action === "suggest") {
      const cover = encodeURIComponent(String(kwargs.cover ?? ""));
      const url = `https://creator.douyin.com/web/api/media/hashtag/rec/?cover_uri=${cover}&aid=1128`;
      const res = (await browserFetch(p, "GET", url)) as {
        hashtag_list: Array<{
          name: string;
          id: string;
          view_count: number;
        }>;
      };
      return (res.hashtag_list ?? []).map((h) => ({
        name: h.name,
        id: h.id,
        view_count: h.view_count,
      }));
    }

    if (action === "hot") {
      const kw = String(kwargs.keyword ?? "");
      const url = `https://creator.douyin.com/aweme/v1/hotspot/recommend/?${kw ? `keyword=${encodeURIComponent(kw)}&` : ""}aid=1128`;
      const res = (await browserFetch(p, "GET", url)) as {
        hotspot_list?: Array<{ sentence: string; hot_value: number }>;
        all_sentences?: Array<{
          sentence_id?: string;
          word?: string;
          hot_value: number;
        }>;
      };
      const items =
        res.hotspot_list ??
        res.all_sentences?.map((h) => ({
          sentence: h.word ?? "",
          hot_value: h.hot_value,
          sentence_id: h.sentence_id ?? "",
        })) ??
        [];
      return items.slice(0, limit).map((h) => ({
        name: h.sentence,
        id:
          "sentence_id" in h ? (h as { sentence_id: string }).sentence_id : "",
        view_count: h.hot_value,
      }));
    }

    throw new Error(`Unknown action: ${action}. Use search, suggest, or hot.`);
  },
});
