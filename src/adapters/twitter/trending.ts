/**
 * Twitter trending — fetch trending topics via the v2 guide API.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import { browserTrendingTopics } from "./browser-fallback.js";
import type { IPage } from "../../types.js";

cli({
  site: "twitter",
  name: "trending",
  description: "Get trending topics",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  browser: true,
  browserSession: "user",
  args: [
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of trends",
    },
  ],
  columns: ["name", "tweet_count", "description", "url"],
  func: async (page, kwargs) => {
    const count = (kwargs.limit as number) ?? 20;
    return browserTrendingTopics(page as IPage, count);
  },
});
