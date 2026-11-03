/**
 * @owner       src::adapters::twitter::search
 * @does        Searches the authenticated X SearchTimeline for posts matching a query.
 * @needs       A user-owned browser session and the browser search client.
 * @feeds       X research workflows and opt-in registry-driven AI community intelligence.
 * @breaks      Missing login state or X GraphQL drift surfaces as an authentication or adapter error.
 * @invariants  This authenticated source is discoverable but never part of unauthenticated AI defaults.
 * @side-effects Reads the user's X session without mutating posts or account state.
 * @perf        Scrolls until the requested posts are collected or three scrolls in a row add none.
 * @concurrency One browser page per invocation.
 * @test        Twitter browser search tests and tests/unit/commands/ai.test.ts
 * @stability   experimental
 * @since       2026-07-17
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import { intArg } from "../_shared/browser-tools.js";
import { browserSearchTweets, TWEET_COLUMNS } from "./browser-extraction.js";
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
  columns: TWEET_COLUMNS,
  operation_effect: "read",
  execution_operator: "browser-protocol",
  retrieval: {
    operation: "discover",
    result_kind: "post",
    source_class: "community",
    arguments: { query: "query", limit: "limit" },
  },
  capabilities: ["cdp-browser.navigate", "cdp-browser.evaluate"],
  func: async (page, kwargs) => {
    const query = kwargs.query as string;
    const count = intArg(kwargs.limit, 20, Number.POSITIVE_INFINITY);
    return browserSearchTweets(page as IPage, query, count);
  },
});
