/**
 * @owner   src/adapters/xiaohongshu/feed.ts
 * @does    Register Xiaohongshu home-feed extraction over a logged-in browser page.
 * @needs   Browser-backed IPage, XHS readable-state checks, visible/store feed extraction.
 * @feeds   xiaohongshu.feed command.
 * @breaks  XHS feed route or note-card DOM drift returns structured empty_result.
 * @invariants Rows expose stable note title, author, likes, type, and canonical note URL.
 * @side-effects Performs authenticated read navigation to Xiaohongshu explore.
 * @perf     One page navigation plus at most one visible DOM extraction per invocation.
 * @concurrency Stateless per invocation.
 * @test     tests/unit/xiaohongshu-feed.test.ts
 * @stability stable
 * @since    2026-06-02
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { socialEmptyError } from "../../social/browser-errors.js";
import { assertXhsReadable, fetchXhsFeedItems } from "./browser-state.js";

export interface XhsFeedRow {
  id: string;
  title: string;
  author: string;
  likes: string;
  type: string;
  url: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function cleanText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeXhsFeedRows(
  items: unknown[],
  limit: number,
): XhsFeedRow[] {
  return items
    .map((item) => {
      const root = asRecord(item);
      const note = asRecord(root.note_card);
      const user = asRecord(note.user);
      const interact = asRecord(note.interact_info);
      const id = cleanText(root.id);
      const title = cleanText(note.display_title);
      if (!id || !title) return null;
      return {
        id,
        title,
        type: cleanText(note.type) || "normal",
        author: cleanText(user.nickname),
        likes: cleanText(interact.liked_count),
        url: `https://www.xiaohongshu.com/explore/${id}`,
      };
    })
    .filter((row): row is XhsFeedRow => row !== null)
    .slice(0, limit);
}

cli({
  site: "xiaohongshu",
  name: "feed",
  description: "Xiaohongshu home feed",
  domain: "www.xiaohongshu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  browserSession: "user",
  args: [
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of items to return",
    },
  ],
  columns: ["title", "author", "likes", "type", "url"],
  capabilities: ["cdp-browser.navigate", "cdp-browser.evaluate"],
  minimum_capability: "cdp-browser.evaluate",
  async func(page, kwargs) {
    const p = page as IPage;
    const limit = Number(kwargs.limit) || 20;
    await p.goto("https://www.xiaohongshu.com/explore", { settleMs: 2500 });
    await p.wait(2);
    await assertXhsReadable(p, "feed");

    const rows = normalizeXhsFeedRows(await fetchXhsFeedItems(p), limit);
    if (rows.length > 0) return rows;

    throw socialEmptyError(
      "xiaohongshu",
      "feed",
      "Xiaohongshu explore loaded no parseable feed rows.",
    );
  },
});
