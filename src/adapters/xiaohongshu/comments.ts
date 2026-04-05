/**
 * Xiaohongshu comments — DOM extraction from note detail page.
 *
 * Supports both top-level comments and nested replies via
 * the --with-replies flag.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { buildNoteUrl } from "./note-helpers.js";

function parseCommentLimit(raw: unknown, fallback = 20): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(Math.floor(n), 50));
}

cli({
  site: "xiaohongshu",
  name: "comments",
  description: "Get comments on a Xiaohongshu note (supports nested replies)",
  domain: "www.xiaohongshu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "note-id",
      required: true,
      positional: true,
      description: "Note ID or full URL",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of top-level comments (max 50)",
    },
    {
      name: "with-replies",
      type: "bool",
      default: false,
      description: "Include nested replies",
    },
  ],
  columns: ["rank", "author", "text", "likes", "time", "is_reply", "reply_to"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const limit = parseCommentLimit(kwargs.limit);
    const withReplies = Boolean(kwargs["with-replies"]);
    const raw = String(kwargs["note-id"]);

    await p.goto(buildNoteUrl(raw));
    await p.wait(3);

    const data = (await p.evaluate(`
      (async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms))
        const withReplies = ${String(withReplies)}
        const loginWall = /登录后查看|请登录/.test(document.body.innerText || '')
        const scroller = document.querySelector('.note-scroller') || document.querySelector('.container')
        if (scroller) {
          for (let i = 0; i < 3; i++) {
            scroller.scrollTo(0, scroller.scrollHeight)
            await wait(1000)
          }
        }
        const clean = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim()
        const parseLikes = (el) => {
          const raw = clean(el)
          return /^\\d+$/.test(raw) ? Number(raw) : 0
        }
        const expandReplyThreads = async (root) => {
          if (!withReplies || !root) return
          const clickedTexts = new Set()
          for (let round = 0; round < 3; round++) {
            const expanders = Array.from(root.querySelectorAll('button, [role="button"], span, div')).filter(el => {
              if (!(el instanceof HTMLElement)) return false
              const text = clean(el)
              if (!text || text.length > 24) return false
              if (!/(展开|更多回复|全部回复|查看.*回复|共\\d+条回复)/.test(text)) return false
              if (clickedTexts.has(text)) return false
              return true
            })
            if (!expanders.length) break
            for (const el of expanders) {
              const text = clean(el)
              el.click()
              clickedTexts.add(text)
              await wait(300)
            }
          }
        }
        const results = []
        const parents = document.querySelectorAll('.parent-comment')
        for (const p of parents) {
          const item = p.querySelector('.comment-item')
          if (!item) continue
          const author = clean(item.querySelector('.author-wrapper .name, .user-name'))
          const text = clean(item.querySelector('.content, .note-text'))
          const likes = parseLikes(item.querySelector('.count'))
          const time = clean(item.querySelector('.date, .time'))
          if (!text) continue
          results.push({ author, text, likes, time, is_reply: false, reply_to: '' })
          if (withReplies) {
            await expandReplyThreads(p)
            p.querySelectorAll('.reply-container .comment-item-sub, .sub-comment-list .comment-item').forEach(sub => {
              const sAuthor = clean(sub.querySelector('.name, .user-name'))
              const sText = clean(sub.querySelector('.content, .note-text'))
              const sLikes = parseLikes(sub.querySelector('.count'))
              const sTime = clean(sub.querySelector('.date, .time'))
              if (!sText) return
              results.push({ author: sAuthor, text: sText, likes: sLikes, time: sTime, is_reply: true, reply_to: author })
            })
          }
        }
        return { loginWall, results }
      })()
    `)) as Record<string, unknown>;

    if (!data || typeof data !== "object") {
      throw new Error("Unexpected evaluate response");
    }

    if (data.loginWall) {
      throw new Error("Note comments require login to www.xiaohongshu.com");
    }

    interface CommentRow {
      author: string;
      text: string;
      likes: number;
      time: string;
      is_reply: boolean;
      reply_to: string;
    }

    const all: CommentRow[] = (data.results as CommentRow[]) ?? [];

    if (withReplies) {
      const limited: CommentRow[] = [];
      let topCount = 0;
      for (const c of all) {
        if (!c.is_reply) topCount++;
        if (topCount > limit) break;
        limited.push(c);
      }
      return limited.map((c, i) => ({ rank: i + 1, ...c }));
    }

    return all.slice(0, limit).map((c, i) => ({ rank: i + 1, ...c }));
  },
});
