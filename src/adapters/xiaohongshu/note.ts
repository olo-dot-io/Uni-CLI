/**
 * Xiaohongshu note — read full note content from a public note page.
 *
 * Extracts title, author, description text, and engagement metrics
 * (likes, collects, comment count) via DOM extraction.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { parseNoteId, buildNoteUrl } from "./note-helpers.js";

cli({
  site: "xiaohongshu",
  name: "note",
  description: "Get note content and engagement metrics",
  domain: "www.xiaohongshu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "note-id",
      required: true,
      positional: true,
      description: "Note ID or full URL (preserves xsec_token for access)",
    },
  ],
  columns: ["field", "value"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const raw = String(kwargs["note-id"]);
    const isBareNoteId = !/^https?:\/\//.test(raw.trim());
    const noteId = parseNoteId(raw);
    const url = buildNoteUrl(raw);

    await p.goto(url);
    await p.wait(3);

    const data = (await p.evaluate(`
      (() => {
        const loginWall = /登录后查看|请登录/.test(document.body.innerText || '')
        const notFound = /页面不见了|笔记不存在|无法浏览/.test(document.body.innerText || '')
        const clean = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim()
        const title = clean(document.querySelector('#detail-title, .title'))
        const desc = clean(document.querySelector('#detail-desc, .desc, .note-text'))
        const author = clean(document.querySelector('.username, .author-wrapper .name'))
        const likes = clean(document.querySelector('.like-wrapper .count'))
        const collects = clean(document.querySelector('.collect-wrapper .count'))
        const comments = clean(document.querySelector('.chat-wrapper .count'))
        const tags = []
        document.querySelectorAll('#detail-desc a.tag, #detail-desc a[href*="search_result"]').forEach(el => {
          const t = (el.textContent || '').trim()
          if (t) tags.push(t)
        })
        return { loginWall, notFound, title, desc, author, likes, collects, comments, tags }
      })()
    `)) as Record<string, unknown>;

    if (!data || typeof data !== "object") {
      throw new Error("Unexpected evaluate response");
    }

    if (data.loginWall) {
      throw new Error("Note content requires login to www.xiaohongshu.com");
    }

    if (data.notFound) {
      throw new Error(
        `Note ${noteId} not found or unavailable — it may have been deleted or restricted`,
      );
    }

    const numOrZero = (v: string) => (/^\d+/.test(v) ? v : "0");
    const emptyShell = !data.title && !data.author;
    if (emptyShell) {
      if (isBareNoteId) {
        throw new Error(
          "Pass the full search_result URL with xsec_token instead of a bare note ID.",
        );
      }
      throw new Error(
        "The note page loaded without visible content. Retry with a fresh URL.",
      );
    }

    const rows: Array<{ field: string; value: string }> = [
      { field: "title", value: String(data.title ?? "") },
      { field: "author", value: String(data.author ?? "") },
      { field: "content", value: String(data.desc ?? "") },
      { field: "likes", value: numOrZero(String(data.likes ?? "")) },
      { field: "collects", value: numOrZero(String(data.collects ?? "")) },
      { field: "comments", value: numOrZero(String(data.comments ?? "")) },
    ];

    const tags = data.tags as string[] | undefined;
    if (tags?.length) {
      rows.push({ field: "tags", value: tags.join(", ") });
    }

    return rows;
  },
});
