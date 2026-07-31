/**
 * @owner       src::adapters::linux-do::search
 * @does        Searches Linux.do topics through the authenticated Discourse JSON surface.
 * @needs       browser-json same-origin authenticated JSON client and current Discourse search response fields.
 * @feeds       Linux.do workflows and opt-in registry-driven Chinese AI community intelligence.
 * @breaks      Authentication or Discourse response drift surfaces as an explicit adapter error.
 * @invariants  This authenticated source is discoverable but never part of unauthenticated AI defaults.
 * @side-effects Reads the forum without mutating user or topic state.
 * @perf        Maps at most 100 topics.
 * @concurrency One browser page per invocation.
 * @test        Linux.do adapter tests and tests/unit/commands/ai.test.ts
 * @stability   experimental
 * @since       2026-07-17
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { fetchLinuxDoJson } from "./browser-json.js";
import "./site.js";

function limitOf(value: unknown): number {
  const n = Number(value ?? 20);
  if (!Number.isFinite(n)) return 20;
  return Math.max(1, Math.min(100, Math.trunc(n)));
}

cli({
  site: "linux-do",
  name: "search",
  description: "Search Linux.do forum topics",
  domain: "linux.do",
  strategy: Strategy.COOKIE,
  browser: true,
  auth_requirement: "required",
  target_surface: "web",
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
  operation_effect: "read",
  execution_operator: "browser-protocol",
  operation_family: "search",
  idempotency: "guaranteed",
  retrieval: {
    operation: "discover",
    result_kind: "post",
    source_class: "community",
    arguments: { query: "query", limit: "limit" },
  },
  capabilities: ["cdp-browser.navigate", "cdp-browser.evaluate"],
  minimum_capability: "cdp-browser.evaluate",
  func: async (page, kwargs, context) => {
    const query = String(kwargs.query ?? "");
    const limit = limitOf(kwargs.limit);
    const data = await fetchLinuxDoJson(
      page as IPage,
      `/search.json?q=${encodeURIComponent(query)}`,
      context.signal,
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
