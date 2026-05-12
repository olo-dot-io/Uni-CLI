/**
 * @owner   src/adapters/tiktok/creator-videos.ts
 * @does    Register agent-facing TikTok Studio creator video list extraction implemented with site-specific safety checks.
 * @needs   Logged-in www.tiktok.com browser session with access to TikTok Studio content management.
 * @feeds   surface coverage ledger and creator analytics workflows for TikTok owned videos.
 * @breaks  TikTok Studio API schema changes, missing creator permissions, auth redirects, or item_list pagination drift.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { str } from "../_shared/browser-tools.js";

const STUDIO_CONTENT_URL = "https://www.tiktok.com/tiktokstudio/content";
const ITEM_LIST_API_PATH = "/tiktok/creator/manage/item_list/v1/";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 250;
const SERVER_PAGE_MAX = 50;

interface TikTokCreatorApiItem {
  item_id?: unknown;
  id?: unknown;
  desc?: unknown;
  title?: unknown;
  post_time?: unknown;
  create_time?: unknown;
  schedule_time?: unknown;
  play_count?: unknown;
  like_count?: unknown;
  comment_count?: unknown;
  favorite_count?: unknown;
  share_count?: unknown;
  author?: { unique_id?: unknown; uniqueId?: unknown };
  author_unique_id?: unknown;
  authorUniqueId?: unknown;
  user_name?: unknown;
  username?: unknown;
  play_addr?: unknown;
  download_info?: { download_urls?: unknown };
}

interface TikTokCreatorApiPayload {
  status_code?: unknown;
  statusCode?: unknown;
  status_msg?: unknown;
  statusMsg?: unknown;
  item_list?: unknown;
  has_more?: unknown;
  cursor?: unknown;
  data?: unknown;
}

interface TikTokCreatorFetchResult {
  ok?: unknown;
  status?: unknown;
  statusText?: unknown;
  data?: unknown;
  text?: unknown;
  parseError?: unknown;
  networkError?: unknown;
}

export function requireTikTokPositiveInt(
  value: unknown,
  label: string,
  fallback: number,
  max: number,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `TikTok creator-videos ${label} must be a positive integer.`,
    );
  }
  if (parsed > max) {
    throw new Error(`TikTok creator-videos ${label} must be <= ${max}.`);
  }
  return parsed;
}

export function requireTikTokCursor(value: unknown): number {
  const text = str(value ?? "0").trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(
      "TikTok creator-videos cursor must be a non-negative integer string.",
    );
  }
  const cursor = Number(text);
  if (!Number.isSafeInteger(cursor)) {
    throw new Error("TikTok creator-videos cursor must be a safe integer.");
  }
  return cursor;
}

export function buildTikTokItemListRequest(cursor: number, size: number) {
  return {
    cursor,
    size,
    query: {
      conditions: [],
      sort_orders: [{ field_name: "create_time", order: 2 }],
    },
  };
}

export function buildTikTokItemListScript(body: unknown): string {
  const request = {
    url: `${ITEM_LIST_API_PATH}?aid=1988`,
    body,
  };
  return `(async () => {
    const request = ${JSON.stringify(request)};
    try {
      const response = await fetch(request.url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(request.body),
      });
      const text = await response.text();
      let data = null;
      if (text.trim()) {
        try {
          data = JSON.parse(text);
        } catch (error) {
          return {
            ok: false,
            status: response.status,
            statusText: response.statusText,
            parseError: error instanceof Error ? error.message : String(error),
            text: text.slice(0, 500),
          };
        }
      }
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        data,
        text: text.slice(0, 500),
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        statusText: '',
        networkError: error instanceof Error ? error.message : String(error),
      };
    }
  })()`;
}

function looksAuthFailure(value: unknown): boolean {
  return /\b(auth|login|log in|permission|unauthori[sz]ed|forbidden)\b/i.test(
    str(value),
  );
}

function unwrapPayload(data: unknown): TikTokCreatorApiPayload {
  if (!data || typeof data !== "object") {
    throw new Error("TikTok Studio item_list returned an empty response.");
  }
  const payload = data as TikTokCreatorApiPayload;
  return payload.data && typeof payload.data === "object"
    ? (payload.data as TikTokCreatorApiPayload)
    : payload;
}

function assertApiSuccess(data: TikTokCreatorApiPayload): void {
  const statusCode = data.status_code ?? data.statusCode;
  const statusMessage = str(data.status_msg ?? data.statusMsg).trim();
  if (statusCode !== undefined && Number(statusCode) !== 0) {
    if (looksAuthFailure(statusMessage)) {
      throw new Error(
        `TikTok Studio item_list requires login or creator permission: ${statusMessage || statusCode}.`,
      );
    }
    throw new Error(
      `TikTok Studio item_list failed: ${statusMessage || statusCode}.`,
    );
  }
  if (statusMessage && !/^(success|ok)$/i.test(statusMessage)) {
    if (looksAuthFailure(statusMessage)) {
      throw new Error(
        `TikTok Studio item_list requires login or creator permission: ${statusMessage}.`,
      );
    }
    throw new Error(`TikTok Studio item_list failed: ${statusMessage}.`);
  }
}

function normalizeCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
}

export function formatTikTokStudioDate(value: unknown): string {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  return new Date(seconds * 1000).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
}

export function extractTikTokUsername(item: TikTokCreatorApiItem): string {
  const direct =
    item.author?.unique_id ??
    item.author?.uniqueId ??
    item.author_unique_id ??
    item.authorUniqueId ??
    item.user_name ??
    item.username;
  if (direct) return str(direct);
  const playAddresses = Array.isArray(item.play_addr) ? item.play_addr : [];
  const downloadUrls = Array.isArray(item.download_info?.download_urls)
    ? item.download_info.download_urls
    : [];
  for (const rawUrl of [...playAddresses, ...downloadUrls]) {
    const match = str(rawUrl).match(/[?&]user_text=([^&]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  return "";
}

export function normalizeTikTokCreatorVideoRow(
  item: TikTokCreatorApiItem,
): Record<string, unknown> | null {
  const videoId = str(item.item_id ?? item.id).trim();
  if (!videoId) return null;
  const username = extractTikTokUsername(item);
  return {
    video_id: videoId,
    title: str(item.desc ?? item.title)
      .replace(/\s+/g, " ")
      .trim(),
    date: formatTikTokStudioDate(
      item.post_time ?? item.create_time ?? item.schedule_time,
    ),
    views: normalizeCount(item.play_count),
    likes: normalizeCount(item.like_count),
    comments: normalizeCount(item.comment_count),
    saves: normalizeCount(item.favorite_count),
    shares: normalizeCount(item.share_count),
    url: username
      ? `https://www.tiktok.com/@${encodeURIComponent(username)}/video/${encodeURIComponent(videoId)}`
      : "",
  };
}

async function fetchCreatorVideosPage(
  page: IPage,
  cursor: number,
  size: number,
): Promise<TikTokCreatorApiPayload> {
  const result = (await page.evaluate(
    buildTikTokItemListScript(buildTikTokItemListRequest(cursor, size)),
  )) as TikTokCreatorFetchResult;
  if (!result || typeof result !== "object") {
    throw new Error("TikTok Studio item_list returned an unreadable response.");
  }
  if (result.networkError) {
    throw new Error(
      `TikTok Studio item_list network failure: ${str(result.networkError)}.`,
    );
  }
  if (result.status === 401 || result.status === 403) {
    throw new Error(
      `TikTok Studio item_list requires login (HTTP ${result.status}).`,
    );
  }
  if (!result.ok) {
    const detail = result.parseError
      ? `invalid JSON (${str(result.parseError)})`
      : `HTTP ${str(result.status || 0)}${result.statusText ? ` ${str(result.statusText)}` : ""}`;
    const preview = str(result.text).slice(0, 160);
    throw new Error(
      `TikTok Studio item_list failed: ${detail}${preview ? `; response preview: ${preview}` : ""}.`,
    );
  }
  const payload = unwrapPayload(result.data);
  assertApiSuccess(payload);
  return payload;
}

async function listCreatorVideos(
  page: IPage,
  kwargs: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const limit = requireTikTokPositiveInt(
    kwargs.limit,
    "limit",
    DEFAULT_LIMIT,
    MAX_LIMIT,
  );
  let cursor = requireTikTokCursor(kwargs.cursor);
  const rows: Record<string, unknown>[] = [];
  let skippedMissingId = 0;
  const pageSize = Math.min(SERVER_PAGE_MAX, limit);
  const maxPages = Math.ceil(limit / pageSize);
  await page.goto(STUDIO_CONTENT_URL, { waitUntil: "load", settleMs: 6000 });
  for (
    let pageIndex = 0;
    pageIndex < maxPages && rows.length < limit;
    pageIndex += 1
  ) {
    const payload = await fetchCreatorVideosPage(page, cursor, pageSize);
    const items = Array.isArray(payload.item_list) ? payload.item_list : [];
    for (const item of items) {
      const row = normalizeTikTokCreatorVideoRow(item as TikTokCreatorApiItem);
      if (!row) {
        skippedMissingId += 1;
        continue;
      }
      rows.push(row);
      if (rows.length >= limit) break;
    }
    if (!payload.has_more || items.length === 0) break;
    cursor = requireTikTokCursor(payload.cursor);
    await page.wait(0.25);
  }
  if (rows.length === 0 && skippedMissingId > 0) {
    throw new Error(
      "TikTok Studio item_list returned videos without stable video_id.",
    );
  }
  if (rows.length === 0) {
    throw new Error(
      "No TikTok Studio creator videos were returned. Confirm the browser profile is logged in and has published content.",
    );
  }
  return rows.slice(0, limit);
}

cli({
  site: "tiktok",
  name: "creator-videos",
  description: "Read TikTok Studio creator content metrics",
  domain: "www.tiktok.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "limit",
      type: "int",
      default: DEFAULT_LIMIT,
      description: `Number of creator videos to return (max ${MAX_LIMIT})`,
    },
    {
      name: "cursor",
      type: "str",
      default: "0",
      description: "Non-negative TikTok Studio pagination cursor",
    },
  ],
  columns: [
    "video_id",
    "title",
    "date",
    "views",
    "likes",
    "comments",
    "saves",
    "shares",
    "url",
  ],
  func: async (page, kwargs) => listCreatorVideos(page as IPage, kwargs),
});
