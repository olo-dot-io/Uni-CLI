/**
 * @owner   src/adapters/xiaohongshu/saved.ts
 * @does    Read saved Xiaohongshu notes from the authenticated profile collection tab.
 * @needs   Browser-backed IPage, Xiaohongshu readable-state checks, and stable note URLs.
 * @feeds   xiaohongshu.saved command and personalized discovery surfaces.
 * @breaks  Profile-tab or note-card DOM drift returns a structured empty result instead of fabricated rows.
 * @invariants Every returned row has a stable note id and Xiaohongshu URL; the current account is used only when id is omitted.
 * @side-effects Navigates and scrolls an authenticated Xiaohongshu profile without mutating account state.
 * @perf    Two navigations when resolving the current user, one otherwise, plus at most four bounded scrolls.
 * @concurrency Stateless per invocation.
 * @test    tests/unit/xiaohongshu-saved.test.ts
 * @stability stable
 * @since   2026-08-10
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import {
  socialAuthError,
  socialEmptyError,
} from "../../social/browser-errors.js";
import { assertXhsReadable } from "./browser-state.js";
import { normalizeXhsUserId } from "./user-helpers.js";

export interface XhsSavedRow {
  rank: number;
  id: string;
  title: string;
  author: string;
  likes: string;
  type: string;
  url: string;
}

interface RawSavedRow {
  id?: unknown;
  title?: unknown;
  author?: unknown;
  likes?: unknown;
  type?: unknown;
  url?: unknown;
}

function cleanText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseSavedLimit(value: unknown): number {
  const limit = Number(value ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    const error = new Error(
      "limit must be an integer between 1 and 100",
    ) as Error & {
      code?: string;
      suggestion?: string;
    };
    error.code = "invalid_input";
    error.suggestion = "Pass --limit with an integer from 1 through 100.";
    throw error;
  }
  return limit;
}

export function normalizeXhsSavedRows(
  payload: unknown,
  limit: number,
): XhsSavedRow[] {
  if (!Array.isArray(payload)) return [];
  const rows: XhsSavedRow[] = [];
  const seen = new Set<string>();
  for (const value of payload) {
    if (!value || typeof value !== "object") continue;
    const raw = value as RawSavedRow;
    const id = cleanText(raw.id);
    const url = cleanText(raw.url);
    if (
      !id ||
      seen.has(id) ||
      !url.startsWith("https://www.xiaohongshu.com/")
    ) {
      continue;
    }
    seen.add(id);
    rows.push({
      rank: rows.length + 1,
      id,
      title: cleanText(raw.title),
      author: cleanText(raw.author),
      likes: cleanText(raw.likes) || "0",
      type: cleanText(raw.type),
      url,
    });
    if (rows.length === limit) break;
  }
  return rows;
}

const CURRENT_USER_ID_JS = `
  (() => {
    const user = window.__INITIAL_STATE__?.user?.userInfo;
    const info = user?._value ?? user ?? {};
    return info.user_id || info.userId || info.userID || '';
  })()
`;

const SAVED_ROWS_JS = `
  (() => {
    const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const normalizeUrl = (href) => {
      if (!href) return '';
      let url;
      try { url = new URL(href, 'https://www.xiaohongshu.com'); }
      catch { return ''; }
      if (url.protocol !== 'https:' || url.hostname !== 'www.xiaohongshu.com') return '';
      return url.toString();
    };
    const rows = [];
    const seen = new Set();
    document.querySelectorAll('section.note-item').forEach((element) => {
      if (element.classList.contains('query-note-item')) return;
      const link =
        element.querySelector('a.cover.mask') ||
        element.querySelector('a[href*="/search_result/"]') ||
        element.querySelector('a[href*="/explore/"]') ||
        element.querySelector('a[href*="/note/"]') ||
        element.querySelector('a[href*="/user/profile/"]');
      const url = normalizeUrl(link?.getAttribute('href') || '');
      const parts = new URL(url).pathname.split('/').filter(Boolean);
      let id = '';
      if (['search_result', 'explore', 'note'].includes(parts[0])) {
        id = parts[1] || '';
      } else if (parts[0] === 'user' && parts[1] === 'profile') {
        id = parts[3] || '';
      }
      if (!id || seen.has(id)) return;
      seen.add(id);
      rows.push({
        id,
        title: clean(element.querySelector('.title, .note-title, a.title, .footer .title span')?.textContent),
        author: clean(element.querySelector('a.author .name, .author-name, .nick-name, .name')?.textContent),
        likes: clean(element.querySelector('.count, .like-count, .like-wrapper .count')?.textContent),
        type: '',
        url,
      });
    });
    return rows;
  })()
`;

async function currentUserId(page: IPage): Promise<string> {
  await page.goto("https://www.xiaohongshu.com/explore", { settleMs: 2500 });
  await page.wait(1);
  await assertXhsReadable(page, "saved");
  const id = cleanText(await page.evaluate(CURRENT_USER_ID_JS));
  if (!id) throw socialAuthError("xiaohongshu", "saved");
  return normalizeXhsUserId(id);
}

cli({
  site: "xiaohongshu",
  name: "saved",
  description:
    "Read saved Xiaohongshu notes for the logged-in account or one profile",
  domain: "www.xiaohongshu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  browserSession: "user",
  operation_effect: "read",
  operation_family: "list",
  args: [
    {
      name: "id",
      description: "User id or profile URL; defaults to the logged-in account",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of saved notes from 1 through 100",
    },
  ],
  columns: ["rank", "id", "title", "author", "likes", "type", "url"],
  capabilities: ["cdp-browser.navigate", "cdp-browser.evaluate"],
  minimum_capability: "cdp-browser.evaluate",
  async func(page, kwargs) {
    const browser = page as IPage;
    const limit = parseSavedLimit(kwargs.limit);
    const userId = kwargs.id
      ? normalizeXhsUserId(String(kwargs.id))
      : await currentUserId(browser);

    const profile = new URL(
      `https://www.xiaohongshu.com/user/profile/${encodeURIComponent(userId)}`,
    );
    profile.searchParams.set("tab", "fav");
    profile.searchParams.set("subTab", "note");
    await browser.goto(profile.toString(), { settleMs: 2500 });
    await browser.wait(1);
    await assertXhsReadable(browser, "saved");

    let rows = normalizeXhsSavedRows(
      await browser.evaluate(SAVED_ROWS_JS),
      limit,
    );
    for (let attempt = 0; rows.length < limit && attempt < 4; attempt += 1) {
      const previous = rows.length;
      await browser.autoScroll({ maxScrolls: 1, delay: 1200 });
      await browser.wait(0.5);
      rows = normalizeXhsSavedRows(
        await browser.evaluate(SAVED_ROWS_JS),
        limit,
      );
      if (rows.length <= previous) break;
    }
    if (rows.length > 0) return rows;

    throw socialEmptyError(
      "xiaohongshu",
      "saved",
      "The saved-notes tab loaded no parseable note cards.",
    );
  },
});
