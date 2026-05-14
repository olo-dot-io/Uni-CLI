/**
 * Twitter search — keyword search using GraphQL SearchTimeline endpoint.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import { browserSearchTweets } from "./browser-fallback.js";
import type { IPage } from "../../types.js";

cli({
  site: "twitter",
  name: "search",
  description: "Search tweets by keyword",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  browser: true,
  browserSession: "user",
  args: [
    {
      name: "query",
      required: true,
      positional: true,
      description: "Search query",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of tweets",
    },
  ],
  columns: ["id", "author", "text", "likes", "retweets", "views", "url"],
  func: async (page, kwargs) => {
    const query = kwargs.query as string;
    const count = Math.min((kwargs.limit as number) ?? 20, 50);
    return browserSearchTweets(page as IPage, query, count);
  },
});
