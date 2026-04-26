import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import {
  clampLimit,
  mapRedditPosts,
  normalizeSubreddit,
  redditChildren,
  redditJson,
} from "./browser-utils.js";

cli({
  site: "reddit",
  name: "search",
  description: "Search Reddit posts",
  domain: "www.reddit.com",
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
      name: "subreddit",
      type: "str",
      default: "",
      description: "Restrict search to a subreddit",
    },
    {
      name: "sort",
      type: "str",
      default: "relevance",
      choices: ["relevance", "hot", "top", "new", "comments"],
      description: "Sort order",
    },
    {
      name: "time",
      type: "str",
      default: "all",
      choices: ["hour", "day", "week", "month", "year", "all"],
      description: "Time window",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of results",
    },
  ],
  columns: ["title", "subreddit", "author", "score", "comments", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const query = String(kwargs.query ?? "");
    const subreddit = normalizeSubreddit(kwargs.subreddit);
    const sort = String(kwargs.sort ?? "relevance");
    const time = String(kwargs.time ?? "all");
    const limit = clampLimit(kwargs.limit);
    const path = subreddit
      ? `/r/${encodeURIComponent(subreddit)}/search.json`
      : "/search.json";
    const data = await redditJson(p, path, {
      q: query,
      sort,
      t: time,
      limit,
      restrict_sr: subreddit ? "on" : "off",
    });

    return mapRedditPosts(redditChildren(data), limit);
  },
});
