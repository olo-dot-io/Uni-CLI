/**
 * @owner       src::adapters::reddit::search
 * @does        Searches Reddit posts through the authenticated browser JSON boundary.
 * @needs       A user-owned Reddit browser session and shared Reddit JSON mapping utilities.
 * @feeds       Reddit research workflows and opt-in registry-driven AI community intelligence.
 * @breaks      Authentication, JSON shape, or listing drift surfaces as an explicit adapter error.
 * @invariants  This authenticated source is discoverable but never part of unauthenticated AI defaults.
 * @side-effects Reads Reddit without mutating account or post state.
 * @perf        Bounded to the normalized requested limit.
 * @concurrency One browser page per invocation.
 * @test        src/adapters/reddit/account.test.ts and tests/unit/commands/ai.test.ts
 * @stability   experimental
 * @since       2026-07-17
 */

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
  capabilities: [
    "cdp-browser.navigate",
    "cdp-browser.evaluate",
    "ai.search",
    "ai.community",
    "ai.post",
  ],
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
