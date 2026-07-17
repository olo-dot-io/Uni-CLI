/**
 * @owner       src::adapters::twitter::search
 * @does        Searches the authenticated X SearchTimeline for posts matching a query.
 * @needs       A user-owned browser session and the browser search client.
 * @feeds       X research workflows and opt-in registry-driven AI community intelligence.
 * @breaks      Missing login state or X GraphQL drift surfaces as an authentication or adapter error.
 * @invariants  This authenticated source is discoverable but never part of unauthenticated AI defaults.
 * @side-effects Reads the user's X session without mutating posts or account state.
 * @perf        Bounded to at most 50 posts per call.
 * @concurrency One browser page per invocation.
 * @test        Twitter browser search tests and tests/unit/commands/ai.test.ts
 * @stability   experimental
 * @since       2026-07-17
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
  capabilities: [
    "cdp-browser.navigate",
    "cdp-browser.evaluate",
    "ai.search",
    "ai.community",
    "ai.post",
  ],
  func: async (page, kwargs) => {
    const query = kwargs.query as string;
    const count = Math.min((kwargs.limit as number) ?? 20, 50);
    return browserSearchTweets(page as IPage, query, count);
  },
});
