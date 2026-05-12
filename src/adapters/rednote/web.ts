/**
 * @owner   src/adapters/rednote/web.ts
 * @does    Register agent-facing Rednote read, notification, and media commands.
 * @needs   Logged-in or challenge-cleared www.rednote.com browser session plus stable Rednote DOM/Pinia stores.
 * @feeds   surface coverage ledger, Rednote research workflows, and media download automation.
 * @breaks  Rednote route drift, Pinia store reshaping, note-card DOM drift, CDN auth changes, or risk-control blocks.
 */

import { join } from "node:path";
import { formatCookieHeader } from "../../engine/cookies.js";
import {
  generateFilename,
  httpDownload,
  mapConcurrent,
} from "../../engine/download.js";
import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import {
  extractXhsUserNotes,
  normalizeXhsUserId,
} from "../xiaohongshu/user-helpers.js";

const REDNOTE_HOST = "www.rednote.com";
const REDNOTE_ORIGIN = `https://${REDNOTE_HOST}`;
const SIGNED_URL_HINT =
  "Pass a full rednote.com note URL with xsec_token from search results or user/profile context.";

export const REDNOTE_NOTE_COLUMNS = ["field", "value"];
export const REDNOTE_SEARCH_COLUMNS = [
  "rank",
  "title",
  "author",
  "likes",
  "published_at",
  "url",
  "author_url",
];
export const REDNOTE_USER_COLUMNS = ["id", "title", "type", "likes", "url"];
export const REDNOTE_COMMENT_COLUMNS = [
  "rank",
  "author",
  "text",
  "likes",
  "time",
  "is_reply",
  "reply_to",
];
export const REDNOTE_FEED_COLUMNS = [
  "id",
  "title",
  "author",
  "likes",
  "type",
  "url",
];
export const REDNOTE_NOTIFICATION_COLUMNS = [
  "rank",
  "user",
  "action",
  "content",
  "note",
  "time",
];
export const REDNOTE_DOWNLOAD_COLUMNS = [
  "index",
  "type",
  "status",
  "path",
  "size",
  "url",
  "error",
];

type JsonRecord = Record<string, unknown>;

interface RednoteCommentRow {
  author: string;
  text: string;
  likes: number;
  time: string;
  is_reply: boolean;
  reply_to: string;
}

interface RednoteMedia {
  type: string;
  url: string;
}

interface RednoteMediaExtract {
  securityBlock?: boolean;
  loginWall?: boolean;
  media?: RednoteMedia[];
}

function cleanString(value: unknown): string {
  return typeof value === "string"
    ? value.trim()
    : value == null
      ? ""
      : String(value).trim();
}

export function parseRednoteLimit(
  raw: unknown,
  fallback: number,
  max?: number,
): number {
  const parsed = Number(raw ?? fallback);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(
      `--limit must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  if (parsed < 1) {
    throw new Error(`--limit must be a positive integer, got ${parsed}`);
  }
  if (max !== undefined && parsed > max) {
    throw new Error(`--limit must be between 1 and ${max}, got ${parsed}`);
  }
  return parsed;
}

export function parseRednoteSearchLimit(raw: unknown): number {
  const parsed = Number(raw ?? 20);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(
      `--limit must be an integer between 1 and 100, got ${JSON.stringify(raw)}`,
    );
  }
  if (parsed < 1 || parsed > 100) {
    throw new Error(`--limit must be between 1 and 100, got ${parsed}`);
  }
  return parsed;
}

export function parseRednoteNotificationType(raw: unknown): string {
  const type = cleanString(raw ?? "mentions");
  if (!["mentions", "likes", "connections"].includes(type)) {
    throw new Error(
      `--type must be one of mentions, likes, or connections, got ${JSON.stringify(raw)}`,
    );
  }
  return type;
}

function requireRednoteHost(input: string, commandName: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`${commandName}: invalid URL. ${SIGNED_URL_HINT}`);
  }
  if (!url.hostname.endsWith("rednote.com")) {
    throw new Error(
      `${commandName}: URL must be on rednote.com. ${SIGNED_URL_HINT}`,
    );
  }
  return url;
}

export function parseRednoteNoteId(input: string): string {
  const trimmed = cleanString(input);
  if (!trimmed) throw new Error("note-id cannot be empty");
  if (/^https?:\/\//i.test(trimmed)) {
    const url = requireRednoteHost(trimmed, "rednote note");
    const match = url.pathname.match(
      /\/(?:explore|note|search_result)\/([a-zA-Z0-9]+)/,
    );
    if (!match?.[1]) {
      throw new Error(
        `rednote note: URL does not contain a note id. ${SIGNED_URL_HINT}`,
      );
    }
    return match[1];
  }
  if (/[/?#]/.test(trimmed)) {
    throw new Error(
      `rednote note: note-id must be a bare id or rednote.com URL. ${SIGNED_URL_HINT}`,
    );
  }
  return trimmed;
}

export function buildRednoteNoteUrl(
  input: string,
  commandName = "rednote note",
): string {
  const trimmed = cleanString(input);
  if (/^https?:\/\//i.test(trimmed)) {
    return requireRednoteHost(trimmed, commandName).toString();
  }
  return `${REDNOTE_ORIGIN}/explore/${parseRednoteNoteId(trimmed)}`;
}

export function normalizeRednoteUserId(input: string): string {
  const trimmed = cleanString(input);
  if (!trimmed) throw new Error("id cannot be empty");
  if (/^https?:\/\//i.test(trimmed)) {
    const url = requireRednoteHost(trimmed, "rednote user");
    const matched = url.pathname.match(/\/user\/profile\/([a-zA-Z0-9]+)/);
    if (!matched?.[1])
      throw new Error("rednote user: URL does not contain a user id");
    return matched[1];
  }
  return normalizeXhsUserId(trimmed);
}

export function rednoteNoteIdToDate(url: string): string {
  const match = url.match(
    /\/(?:search_result|explore|note)\/([0-9a-f]{24})(?=[?#/]|$)/i,
  );
  if (!match) return "";
  const timestamp = parseInt(match[1].slice(0, 8), 16);
  if (!timestamp || timestamp < 1_000_000_000 || timestamp > 4_000_000_000)
    return "";
  return new Date((timestamp + 8 * 3600) * 1000).toISOString().slice(0, 10);
}

export function buildRednoteSearchWaitScript(): string {
  return `
    new Promise((resolve) => {
      const hasLoginModal = () => {
        const candidates = document.querySelectorAll('[class*="login-modal"], [class*="LoginModal"], [class*="login-container"], [class*="LoginContainer"], dialog[role="dialog"]');
        for (const el of candidates) {
          if (!(el instanceof HTMLElement)) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          return true;
        }
        return false;
      };
      const detect = () => {
        if (document.querySelector('section.note-item')) return 'content';
        if (/登录后查看搜索结果|请登录/.test(document.body?.innerText || '')) return 'login_wall';
        if (hasLoginModal()) return 'login_wall';
        return null;
      };
      const found = detect();
      if (found) return resolve(found);
      const observer = new MutationObserver(() => {
        const result = detect();
        if (result) { observer.disconnect(); resolve(result); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { observer.disconnect(); resolve('timeout'); }, 5000);
    })
  `;
}

export function buildRednoteScrollUntilScript(limit: number): string {
  return `
    (async () => {
      const target = ${JSON.stringify(limit)};
      let previous = -1;
      let stable = 0;
      for (let i = 0; i < 10; i += 1) {
        const count = document.querySelectorAll('section.note-item').length;
        if (count >= target) return { count, stable: false };
        if (count === previous) stable += 1;
        else stable = 0;
        if (stable >= 2) return { count, stable: true };
        previous = count;
        window.scrollTo(0, document.body.scrollHeight);
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
      return { count: document.querySelectorAll('section.note-item').length, stable: true };
    })()
  `;
}

export function buildRednoteSearchExtractScript(): string {
  return `
    (() => {
      const normalizeUrl = (href) => {
        if (!href) return '';
        if (href.startsWith('http://') || href.startsWith('https://')) return href;
        if (href.startsWith('/')) return '${REDNOTE_ORIGIN}' + href;
        return '';
      };
      const cleanText = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const results = [];
      const seen = new Set();
      document.querySelectorAll('section.note-item').forEach((el) => {
        if (el.classList.contains('query-note-item')) return;
        const titleEl = el.querySelector('.title, .note-title, a.title, .footer .title span');
        const authorEl = el.querySelector('a.author .name, .name, .author-name, .nick-name, a.author');
        const likesEl = el.querySelector('.count, .like-count, .like-wrapper .count');
        const detailLinkEl = el.querySelector('a.cover.mask') || el.querySelector('a[href*="/search_result/"]') || el.querySelector('a[href*="/explore/"]') || el.querySelector('a[href*="/note/"]');
        const authorLinkEl = el.querySelector('a.author[href*="/user/profile/"], a[href*="/user/profile/"]');
        const url = normalizeUrl(detailLinkEl?.getAttribute('href') || '');
        if (!url || seen.has(url)) return;
        seen.add(url);
        results.push({
          title: cleanText(titleEl?.textContent || ''),
          author: cleanText(authorEl?.textContent || ''),
          likes: cleanText(likesEl?.textContent || '0'),
          url,
          author_url: normalizeUrl(authorLinkEl?.getAttribute('href') || ''),
        });
      });
      return results;
    })()
  `;
}

export function buildRednoteNoteExtractScript(): string {
  return `
    (() => {
      const body = document.body?.innerText || '';
      const loginWall = /登录后查看|请登录|Log in to view/.test(body);
      const notFound = /页面不见了|笔记不存在|无法浏览|not found|unavailable/i.test(body);
      const securityBlock = /访问频繁|安全验证|risk control|Security Verification|Access Denied/i.test(body);
      const clean = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim();
      const title = clean(document.querySelector('#detail-title, .title'));
      const desc = clean(document.querySelector('#detail-desc, .desc, .note-text'));
      const author = clean(document.querySelector('.username, .author-wrapper .name, .user-name'));
      const likes = clean(document.querySelector('.like-wrapper .count, [class*="like"] .count'));
      const collects = clean(document.querySelector('.collect-wrapper .count, [class*="collect"] .count'));
      const comments = clean(document.querySelector('.chat-wrapper .count, [class*="comment"] .count'));
      const tags = [];
      document.querySelectorAll('#detail-desc a.tag, #detail-desc a[href*="search_result"], a[href*="search_result?keyword="]').forEach((el) => {
        const text = clean(el);
        if (text) tags.push(text);
      });
      return { loginWall, notFound, securityBlock, title, desc, author, likes, collects, comments, tags };
    })()
  `;
}

export function buildRednoteCommentsExtractScript(
  withReplies: boolean,
): string {
  return `
    (async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const body = document.body?.innerText || '';
      const loginWall = /登录后查看|请登录|Log in to view/.test(body);
      const securityBlock = /访问频繁|安全验证|risk control|Security Verification|Access Denied/i.test(body);
      const scroller = document.querySelector('.note-scroller') || document.querySelector('.container') || document.scrollingElement;
      if (scroller) {
        for (let i = 0; i < 3; i += 1) {
          scroller.scrollTo(0, scroller.scrollHeight);
          await wait(700);
        }
      }
      const clean = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim();
      const parseLikes = (el) => {
        const raw = clean(el);
        return /^\\d+$/.test(raw) ? Number(raw) : 0;
      };
      const expandReplyThreads = async (root) => {
        if (!${JSON.stringify(withReplies)} || !root) return;
        const clickedTexts = new Set();
        for (let round = 0; round < 3; round += 1) {
          const expanders = Array.from(root.querySelectorAll('button, [role="button"], span, div')).filter((el) => {
            if (!(el instanceof HTMLElement)) return false;
            const text = clean(el);
            if (!text || text.length > 24) return false;
            if (!/(展开|更多回复|全部回复|查看.*回复|共\\d+条回复)/.test(text)) return false;
            if (clickedTexts.has(text)) return false;
            return true;
          });
          if (!expanders.length) break;
          for (const el of expanders) {
            const text = clean(el);
            el.click();
            clickedTexts.add(text);
            await wait(300);
          }
        }
      };
      const results = [];
      const parents = document.querySelectorAll('.parent-comment, .comment-item');
      for (const parent of parents) {
        const item = parent.matches?.('.comment-item') ? parent : parent.querySelector('.comment-item');
        if (!item) continue;
        const author = clean(item.querySelector('.author-wrapper .name, .user-name, .name'));
        const text = clean(item.querySelector('.content, .note-text, .comment-content'));
        const likes = parseLikes(item.querySelector('.count, .like-count'));
        const time = clean(item.querySelector('.date, .time'));
        if (!text) continue;
        results.push({ author, text, likes, time, is_reply: false, reply_to: '' });
        if (${JSON.stringify(withReplies)}) {
          await expandReplyThreads(parent);
          parent.querySelectorAll('.reply-container .comment-item-sub, .sub-comment-list .comment-item, .reply-item').forEach((sub) => {
            const sAuthor = clean(sub.querySelector('.name, .user-name'));
            const sText = clean(sub.querySelector('.content, .note-text, .comment-content'));
            const sLikes = parseLikes(sub.querySelector('.count, .like-count'));
            const sTime = clean(sub.querySelector('.date, .time'));
            if (!sText) return;
            results.push({ author: sAuthor, text: sText, likes: sLikes, time: sTime, is_reply: true, reply_to: author });
          });
        }
      }
      return { loginWall, securityBlock, results };
    })()
  `;
}

export function buildRednoteFeedReadScript(): string {
  return `
    (() => {
      let pinia = null;
      const probe = (el) => el?.__vue_app__?.config?.globalProperties?.$pinia ?? null;
      pinia = probe(document.querySelector('#app'));
      if (!pinia) {
        for (const el of document.querySelectorAll('*')) {
          pinia = probe(el);
          if (pinia) break;
        }
      }
      if (!pinia || !pinia._s) return { error: 'no_pinia' };
      const store = pinia._s.get('feed');
      if (!store) return { error: 'no_feed_store' };
      const feeds = store.feeds;
      if (!Array.isArray(feeds)) return { error: 'feeds_not_array' };
      return {
        items: feeds.map((entry) => {
          const card = entry?.noteCard ?? {};
          return {
            id: entry?.id ?? '',
            title: card.displayTitle ?? '',
            type: card.type ?? '',
            author: card.user?.nickName ?? card.user?.nickname ?? '',
            likes: card.interactInfo?.likedCount ?? '',
          };
        }),
      };
    })()
  `;
}

export function buildRednoteNotificationsReadScript(type: string): string {
  return `
    (async () => {
      const type = ${JSON.stringify(type)};
      let pinia = null;
      const probe = (el) => el?.__vue_app__?.config?.globalProperties?.$pinia ?? null;
      pinia = probe(document.querySelector('#app'));
      if (!pinia) {
        for (const el of document.querySelectorAll('*')) {
          pinia = probe(el);
          if (pinia) break;
        }
      }
      if (!pinia || !pinia._s) return { error: 'no_pinia' };
      const store = pinia._s.get('notification');
      if (!store) return { error: 'no_notification_store' };
      if (typeof store.getNotification !== 'function') return { error: 'no_getNotification_action' };
      try {
        await store.getNotification(type);
      } catch (e) {
        return { error: 'action_failed', detail: e?.message };
      }
      const readMessages = () => {
        if (Array.isArray(store.activeTabMessageList) && store.activeTabMessageList.length > 0) return store.activeTabMessageList;
        const tab = store.notificationMap?.[type];
        if (Array.isArray(tab) && tab.length > 0) return tab;
        if (Array.isArray(tab?.messages) && tab.messages.length > 0) return tab.messages;
        if (Array.isArray(tab?.messageList) && tab.messageList.length > 0) return tab.messageList;
        return null;
      };
      let messages = null;
      for (let i = 0; i < 16; i += 1) {
        messages = readMessages();
        if (messages) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const arr = messages ?? (Array.isArray(store.activeTabMessageList) ? store.activeTabMessageList : []);
      const pick = (item, snake, camel) => item?.[snake] ?? item?.[camel];
      const leafVariants = (leaf) => {
        const camel = leaf.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        const snake = leaf.replace(/([A-Z])/g, (_, c) => '_' + c.toLowerCase());
        const capCamel = leaf.charAt(0) + leaf.slice(1).replace(/(^|_)([a-z])/g, (_, sep, c) => (sep ? c.toUpperCase() : c));
        return [...new Set([leaf, camel, snake, capCamel])];
      };
      const nested = (item, snake, camel, ...leafCandidates) => {
        const target = pick(item, snake, camel);
        if (!target || typeof target !== 'object') return '';
        for (const candidate of leafCandidates) {
          for (const variant of leafVariants(candidate)) {
            if (target[variant] != null && target[variant] !== '') return target[variant];
          }
        }
        return '';
      };
      return {
        items: arr.map((item) => ({
          user: nested(item, 'user_info', 'userInfo', 'nickname', 'nickName'),
          action: item?.title ?? item?.actionTitle ?? '',
          content: nested(item, 'comment_info', 'commentInfo', 'content'),
          note: nested(item, 'item_info', 'itemInfo', 'content'),
          time: item?.time ?? item?.timestamp ?? '',
        })),
      };
    })()
  `;
}

export function buildRednoteMediaExtractScript(noteId: string): string {
  return `
    (() => {
      const result = { noteId: ${JSON.stringify(noteId)}, media: [] };
      const body = document.body?.innerText || '';
      const loginWall = /登录后查看|请登录|Log in to view/.test(body);
      const securityBlock = /访问频繁|安全验证|risk control|Security Verification|Access Denied/i.test(body);
      const seen = new Set();
      const pushMedia = (type, url) => {
        if (!url || typeof url !== 'string') return;
        if (url.startsWith('blob:')) return;
        const normalized = url.replace(/\\\\u002F/g, '/').split('?')[0];
        if (!/^https?:\\/\\//.test(normalized)) return;
        if (!/(rednote|xiaohongshu|xhscdn|sns-video|ci\\.)/i.test(normalized)) return;
        const key = type + ':' + normalized;
        if (seen.has(key)) return;
        seen.add(key);
        result.media.push({ type, url: normalized });
      };
      document.querySelectorAll('img').forEach((img) => {
        const src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
        pushMedia('image', src);
      });
      document.querySelectorAll('video source, video[src]').forEach((video) => {
        const src = video.src || video.getAttribute('src') || '';
        pushMedia('video', src);
      });
      const state = window.__INITIAL_STATE__;
      try {
        const noteData = state?.note?.noteDetailMap ?? state?.note?.note ?? {};
        for (const key of Object.keys(noteData)) {
          const note = noteData[key]?.note ?? noteData[key];
          const imageList = note?.imageList ?? note?.image_list ?? [];
          for (const image of imageList) {
            pushMedia('image', image?.urlDefault ?? image?.urlPre ?? image?.url ?? image?.traceId);
          }
          const video = note?.video;
          if (video) {
            pushMedia('video', video.url ?? video.originVideoKey ?? video.consumer?.originVideoKey);
            const streams = video.media?.stream?.h264 ?? [];
            for (const stream of streams) pushMedia('video', stream.masterUrl ?? stream.backupUrls?.[0]);
          }
        }
      } catch {}
      return { ...result, loginWall, securityBlock };
    })()
  `;
}

async function readUserSnapshot(
  page: IPage,
): Promise<{ noteGroups: unknown; pageData: unknown }> {
  return (await page.evaluate(`
    (() => {
      const safeClone = (value) => {
        try {
          return JSON.parse(JSON.stringify(value ?? null));
        } catch {
          return null;
        }
      };
      const userStore = window.__INITIAL_STATE__?.user || {};
      return {
        noteGroups: safeClone(userStore.notes?._value || userStore.notes || []),
        pageData: safeClone(userStore.userPageData?._value || userStore.userPageData || {}),
      };
    })()
  `)) as { noteGroups: unknown; pageData: unknown };
}

function noteRows(
  data: JsonRecord,
  noteId: string,
): Array<{ field: string; value: string }> {
  if (data.loginWall)
    throw new Error("Note content requires login to www.rednote.com");
  if (data.securityBlock) {
    throw new Error(
      `Rednote security block: the note detail page was blocked by risk control. ${SIGNED_URL_HINT}`,
    );
  }
  if (data.notFound) {
    throw new Error(
      `Note ${noteId} not found or unavailable - it may have been deleted or restricted`,
    );
  }
  if (!data.title && !data.author) {
    throw new Error(
      "The note page loaded without visible content. The note may be deleted or restricted.",
    );
  }
  const numOrZero = (value: string) => (/^\d+/.test(value) ? value : "0");
  const rows = [
    { field: "title", value: cleanString(data.title) },
    { field: "author", value: cleanString(data.author) },
    { field: "content", value: cleanString(data.desc) },
    { field: "likes", value: numOrZero(cleanString(data.likes)) },
    { field: "collects", value: numOrZero(cleanString(data.collects)) },
    { field: "comments", value: numOrZero(cleanString(data.comments)) },
  ];
  const tags = Array.isArray(data.tags)
    ? data.tags.map(cleanString).filter(Boolean)
    : [];
  if (tags.length) rows.push({ field: "tags", value: tags.join(", ") });
  return rows;
}

cli({
  site: "rednote",
  name: "note",
  description: "Read note body and engagement counts from a rednote note",
  domain: REDNOTE_HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "note-id",
      required: true,
      positional: true,
      description: "Full rednote note URL with xsec_token",
    },
  ],
  columns: REDNOTE_NOTE_COLUMNS,
  func: async (page, kwargs) => {
    const p = page as IPage;
    const raw = cleanString(kwargs["note-id"]);
    const noteId = parseRednoteNoteId(raw);
    await p.goto(buildRednoteNoteUrl(raw, "rednote note"));
    await p.wait(2);
    const data = (await p.evaluate(
      buildRednoteNoteExtractScript(),
    )) as JsonRecord | null;
    if (!data || typeof data !== "object")
      throw new Error("rednote/note: unexpected evaluate response");
    return noteRows(data, noteId);
  },
});

cli({
  site: "rednote",
  name: "search",
  description: "Search rednote notes",
  domain: REDNOTE_HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "query",
      required: true,
      positional: true,
      description: "Search keyword",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of results",
    },
  ],
  columns: REDNOTE_SEARCH_COLUMNS,
  func: async (page, kwargs) => {
    const p = page as IPage;
    const query = cleanString(kwargs.query);
    if (!query) throw new Error("query cannot be empty");
    const limit = parseRednoteSearchLimit(kwargs.limit);
    await p.goto(
      `${REDNOTE_ORIGIN}/search_result?keyword=${encodeURIComponent(query)}&source=web_search_result_notes`,
    );
    const waitResult = await p.evaluate(buildRednoteSearchWaitScript());
    if (waitResult === "login_wall") {
      throw new Error("Rednote search results are blocked behind a login wall");
    }
    await p.evaluate(buildRednoteScrollUntilScript(limit));
    const payload = await p.evaluate(buildRednoteSearchExtractScript());
    const data = Array.isArray(payload) ? (payload as JsonRecord[]) : [];
    return data
      .filter((item) => cleanString(item.title))
      .slice(0, limit)
      .map((item, index) => ({
        rank: index + 1,
        title: cleanString(item.title),
        author: cleanString(item.author),
        likes: cleanString(item.likes || "0"),
        published_at: rednoteNoteIdToDate(cleanString(item.url)),
        url: cleanString(item.url),
        author_url: cleanString(item.author_url),
      }));
  },
});

cli({
  site: "rednote",
  name: "user",
  description: "Get public notes from a rednote user profile",
  domain: REDNOTE_HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "id",
      type: "str",
      required: true,
      positional: true,
      description: "User id or profile URL",
    },
    {
      name: "limit",
      type: "int",
      default: 15,
      description: "Number of notes to return",
    },
  ],
  columns: REDNOTE_USER_COLUMNS,
  func: async (page, kwargs) => {
    const p = page as IPage;
    const userId = normalizeRednoteUserId(String(kwargs.id));
    const limit = parseRednoteLimit(kwargs.limit, 15);
    await p.goto(`${REDNOTE_ORIGIN}/user/profile/${userId}`);
    let snapshot = await readUserSnapshot(p);
    let results = extractXhsUserNotes(snapshot ?? {}, userId, REDNOTE_HOST);
    let previousCount = results.length;
    for (let i = 0; results.length < limit && i < 4; i += 1) {
      await p.autoScroll({ maxScrolls: 1, delay: 1500 });
      await p.wait(1);
      snapshot = await readUserSnapshot(p);
      const nextResults = extractXhsUserNotes(
        snapshot ?? {},
        userId,
        REDNOTE_HOST,
      );
      if (nextResults.length <= previousCount) break;
      results = nextResults;
      previousCount = nextResults.length;
    }
    if (results.length === 0)
      throw new Error("No public notes found for this rednote user.");
    return results.slice(0, limit);
  },
});

cli({
  site: "rednote",
  name: "comments",
  description: "Read comments from a rednote note (supports nested replies)",
  domain: REDNOTE_HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "note-id",
      required: true,
      positional: true,
      description: "Full rednote note URL with xsec_token",
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
  columns: REDNOTE_COMMENT_COLUMNS,
  func: async (page, kwargs) => {
    const p = page as IPage;
    const limit = parseRednoteLimit(kwargs.limit, 20, 50);
    const withReplies = Boolean(kwargs["with-replies"]);
    const raw = cleanString(kwargs["note-id"]);
    await p.goto(buildRednoteNoteUrl(raw, "rednote comments"));
    await p.wait(2);
    const data = (await p.evaluate(
      buildRednoteCommentsExtractScript(withReplies),
    )) as JsonRecord | null;
    if (!data || typeof data !== "object")
      throw new Error("rednote/comments: unexpected evaluate response");
    if (data.securityBlock) {
      throw new Error(
        `Rednote security block: the note detail page was blocked by risk control. ${SIGNED_URL_HINT}`,
      );
    }
    if (data.loginWall)
      throw new Error("Note comments require login to www.rednote.com");
    const all: RednoteCommentRow[] = Array.isArray(data.results)
      ? (data.results as RednoteCommentRow[])
      : [];
    if (withReplies) {
      const limited: RednoteCommentRow[] = [];
      let topCount = 0;
      for (const row of all) {
        if (!row.is_reply) topCount += 1;
        if (topCount > limit) break;
        limited.push(row);
      }
      return limited.map((row, index) => ({ rank: index + 1, ...row }));
    }
    return all
      .slice(0, limit)
      .map((row, index) => ({ rank: index + 1, ...row }));
  },
});

cli({
  site: "rednote",
  name: "feed",
  description: "Rednote home feed (reads hydrated Pinia store)",
  domain: REDNOTE_HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of items to return",
    },
  ],
  columns: REDNOTE_FEED_COLUMNS,
  func: async (page, kwargs) => {
    const p = page as IPage;
    const limit = parseRednoteLimit(kwargs.limit, 20);
    await p.goto(`${REDNOTE_ORIGIN}/explore`);
    await p.wait(2);
    const data = (await p.evaluate(
      buildRednoteFeedReadScript(),
    )) as JsonRecord | null;
    if (!data || typeof data !== "object")
      throw new Error("rednote feed: unexpected evaluate response");
    if (data.error) throw new Error(`rednote feed: ${cleanString(data.error)}`);
    const items = Array.isArray(data.items) ? (data.items as JsonRecord[]) : [];
    const rows = items
      .filter((row) => cleanString(row.id))
      .slice(0, limit)
      .map((row) => ({
        id: cleanString(row.id),
        title: cleanString(row.title),
        author: cleanString(row.author),
        likes: cleanString(row.likes),
        type: cleanString(row.type),
        url: `${REDNOTE_ORIGIN}/explore/${cleanString(row.id)}`,
      }));
    if (rows.length === 0)
      throw new Error("No feed items in the hydrated store.");
    return rows;
  },
});

cli({
  site: "rednote",
  name: "notifications",
  description: "Rednote notifications (mentions/likes/connections)",
  domain: REDNOTE_HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "type",
      default: "mentions",
      description: "Notification type: mentions, likes, or connections",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of notifications to return",
    },
  ],
  columns: REDNOTE_NOTIFICATION_COLUMNS,
  func: async (page, kwargs) => {
    const p = page as IPage;
    const type = parseRednoteNotificationType(kwargs.type);
    const limit = parseRednoteLimit(kwargs.limit, 20);
    await p.goto(`${REDNOTE_ORIGIN}/notification`);
    await p.wait(2);
    const data = (await p.evaluate(
      buildRednoteNotificationsReadScript(type),
    )) as JsonRecord | null;
    if (!data || typeof data !== "object")
      throw new Error("rednote notifications: unexpected evaluate response");
    if (data.error) {
      const detail = cleanString(data.detail);
      throw new Error(
        `rednote notifications: ${cleanString(data.error)}${detail ? ` (${detail})` : ""}`,
      );
    }
    const items = Array.isArray(data.items) ? (data.items as JsonRecord[]) : [];
    return items.slice(0, limit).map((row, index) => ({
      rank: index + 1,
      user: cleanString(row.user),
      action: cleanString(row.action),
      content: cleanString(row.content),
      note: cleanString(row.note),
      time: cleanString(row.time),
    }));
  },
});

cli({
  site: "rednote",
  name: "download",
  description: "Download images and videos from a rednote note",
  domain: REDNOTE_HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "note-id",
      positional: true,
      required: true,
      description: "Full rednote note URL with xsec_token",
    },
    {
      name: "output",
      default: "./rednote-downloads",
      description: "Output directory",
    },
  ],
  columns: REDNOTE_DOWNLOAD_COLUMNS,
  func: async (page, kwargs) => {
    const p = page as IPage;
    const raw = cleanString(kwargs["note-id"]);
    const noteId = parseRednoteNoteId(raw);
    const output = cleanString(kwargs.output || "./rednote-downloads");
    if (!output) throw new Error("output cannot be empty");
    await p.goto(buildRednoteNoteUrl(raw, "rednote download"));
    await p.wait(2);
    const extracted = (await p.evaluate(
      buildRednoteMediaExtractScript(noteId),
    )) as RednoteMediaExtract | null;
    if (!extracted || typeof extracted !== "object")
      throw new Error("rednote/download: unexpected evaluate response");
    if (extracted.securityBlock) {
      throw new Error(
        `Rednote security block: the note detail page was blocked by risk control. ${SIGNED_URL_HINT}`,
      );
    }
    if (extracted.loginWall)
      throw new Error("Note media requires login to www.rednote.com");
    const media = Array.isArray(extracted.media) ? extracted.media : [];
    if (media.length === 0)
      throw new Error("No downloadable media found on this rednote note.");
    const cookieHeader = formatCookieHeader(await p.cookies());
    const results = await mapConcurrent(media, 3, async (item, index) => {
      const filename = `${index + 1}-${generateFilename(item.url, index + 1)}`;
      const result = await httpDownload(
        item.url,
        join(output, filename),
        cookieHeader ? { Cookie: cookieHeader } : undefined,
      );
      return {
        index: index + 1,
        type: item.type,
        status: result.status,
        path: result.path ?? "",
        size: result.size ?? 0,
        url: item.url,
        error: result.error ?? "",
      };
    });
    return results;
  },
});
