/**
 * Unified Endpoint Analysis — combines analysis.ts filters with
 * response body analysis and auth detection for the discover pipeline.
 *
 * Used by: explore.ts, synthesize.ts, generate.ts, discover.ts
 */

import {
  isNoiseUrl,
  isStaticResource,
  isUsefulEndpoint,
  endpointSortKey,
  detectCapability,
} from "./analysis.js";

// ── Types ────────────────────────────────────────────────────────────────

export interface NetworkEntry {
  url: string;
  method: string;
  status: number;
  contentType: string;
  body?: unknown;
  requestHeaders?: Record<string, string>;
}

export interface QueryParamClassification {
  params: string[];
  hasSearch: boolean;
  hasPagination: boolean;
  hasLimit: boolean;
  hasId: boolean;
}

export interface ResponseAnalysis {
  itemPath: string | null;
  itemCount: number;
  detectedFields: Record<string, string>; // role → actual field name
}

export interface AnalyzedEndpoint {
  url: string;
  method: string;
  status: number;
  contentType: string;
  body?: unknown;
  pattern: string;
  capability: string | null;
  sortKey: [number, number, number, number];
  queryParams: QueryParamClassification;
  authIndicators: string[];
  responseAnalysis: ResponseAnalysis | null;
}

// ── Constants ────────────────────────────────────────────────────────────

const SEARCH_PARAMS = new Set([
  "query",
  "keyword",
  "q",
  "search",
  "s",
  "wd",
  "kw",
  "keywords",
]);
const PAGINATION_PARAMS = new Set([
  "page",
  "p",
  "offset",
  "start",
  "from",
  "pageNum",
  "pn",
]);
const LIMIT_PARAMS = new Set([
  "limit",
  "count",
  "size",
  "num",
  "per_page",
  "pageSize",
  "ps",
]);
const ID_PARAMS = new Set([
  "id",
  "uid",
  "pid",
  "item_id",
  "user_id",
  "mid",
  "aid",
  "bvid",
]);

const ARRAY_FIELD_NAMES = new Set([
  "data",
  "items",
  "results",
  "list",
  "records",
  "entries",
  "rows",
  "hits",
  "posts",
  "articles",
  "comments",
  "nodes",
]);

/** Role → candidate field names (order = priority) */
const ROLE_FIELDS: Record<string, string[]> = {
  title: ["title", "name", "headline", "subject", "display_name"],
  url: ["url", "link", "href", "web_url", "share_url", "target_url"],
  author: [
    "author",
    "user",
    "username",
    "creator",
    "nickname",
    "screen_name",
    "user_name",
  ],
  score: [
    "score",
    "upvotes",
    "likes",
    "hot",
    "digg_count",
    "voteup_count",
    "like_count",
    "reply_count",
  ],
  time: [
    "time",
    "created_at",
    "updated_at",
    "date",
    "publish_time",
    "ctime",
    "create_time",
    "pubdate",
  ],
  description: [
    "description",
    "desc",
    "summary",
    "abstract",
    "excerpt",
    "content",
  ],
  image: ["image", "cover", "thumbnail", "pic", "avatar", "cover_url", "thumb"],
  id: ["id", "uid", "pid", "item_id", "aid", "bvid", "mid"],
};

// ── Query Param Classification ──────────────────────────────────────────

export function classifyQueryParams(url: string): QueryParamClassification {
  const params: string[] = [];
  let hasSearch = false;
  let hasPagination = false;
  let hasLimit = false;
  let hasId = false;

  try {
    const u = new URL(url);
    for (const key of u.searchParams.keys()) {
      params.push(key);
      if (SEARCH_PARAMS.has(key)) hasSearch = true;
      if (PAGINATION_PARAMS.has(key)) hasPagination = true;
      if (LIMIT_PARAMS.has(key)) hasLimit = true;
      if (ID_PARAMS.has(key)) hasId = true;
    }
  } catch {
    /* invalid URL */
  }

  return { params, hasSearch, hasPagination, hasLimit, hasId };
}

// ── Response Body Analysis ──────────────────────────────────────────────

export function analyzeResponseBody(body: unknown): ResponseAnalysis {
  if (body === null || body === undefined) {
    return { itemPath: null, itemCount: 0, detectedFields: {} };
  }

  let items: unknown[] | null = null;
  let itemPath: string | null = null;

  // Direct array
  if (Array.isArray(body)) {
    items = body;
    itemPath = null; // root is the array
  } else if (typeof body === "object") {
    const obj = body as Record<string, unknown>;
    // Check known array field names
    for (const key of Object.keys(obj)) {
      if (ARRAY_FIELD_NAMES.has(key) && Array.isArray(obj[key])) {
        items = obj[key] as unknown[];
        itemPath = key;
        break;
      }
    }
    // Fallback: check nested .data.list, .data.items patterns
    if (
      !items &&
      obj.data &&
      typeof obj.data === "object" &&
      !Array.isArray(obj.data)
    ) {
      const nested = obj.data as Record<string, unknown>;
      for (const key of Object.keys(nested)) {
        if (
          Array.isArray(nested[key]) &&
          (nested[key] as unknown[]).length > 0
        ) {
          items = nested[key] as unknown[];
          itemPath = `data.${key}`;
          break;
        }
      }
    }
  }

  if (!items || items.length === 0) {
    return { itemPath, itemCount: 0, detectedFields: {} };
  }

  // Detect semantic fields from first array item
  const firstItem = items[0];
  const detectedFields: Record<string, string> = {};

  if (firstItem && typeof firstItem === "object" && !Array.isArray(firstItem)) {
    const itemObj = firstItem as Record<string, unknown>;
    const flatKeys = Object.keys(itemObj);

    for (const [role, candidates] of Object.entries(ROLE_FIELDS)) {
      for (const candidate of candidates) {
        // Direct match
        if (flatKeys.includes(candidate) && itemObj[candidate] != null) {
          detectedFields[role] = candidate;
          break;
        }
        // Nested match: e.g. author.name, owner.login
        for (const key of flatKeys) {
          const val = itemObj[key];
          if (val && typeof val === "object" && !Array.isArray(val)) {
            const nested = val as Record<string, unknown>;
            if (candidate in nested && nested[candidate] != null) {
              detectedFields[role] = `${key}.${candidate}`;
              break;
            }
          }
        }
        if (detectedFields[role]) break;
      }
    }
  }

  return { itemPath, itemCount: items.length, detectedFields };
}

// ── Auth Indicators ─────────────────────────────────────────────────────

export function detectAuthIndicators(
  headers: Record<string, string>,
): string[] {
  const indicators: string[] = [];
  const headerStr = JSON.stringify(headers).toLowerCase();

  if (headerStr.includes("bearer")) indicators.push("bearer");
  if (
    headerStr.includes("x-csrf-token") ||
    headerStr.includes("ct0") ||
    headerStr.includes("bili_jct")
  ) {
    indicators.push("csrf");
  }
  if (
    headerStr.includes("signature") ||
    headerStr.includes("x-signature") ||
    headerStr.includes("_signature")
  ) {
    indicators.push("signature");
  }
  if (headerStr.includes("cookie")) indicators.push("cookie");

  return indicators;
}

// ── URL Pattern ─────────────────────────────────────────────────────────

export function urlToPattern(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split("/")
      .map((seg) => (/^\d{4,}$/.test(seg) ? ":id" : seg))
      .join("/");
    const params = [...u.searchParams.keys()].sort().join(",");
    return `${u.host}${path}${params ? "?" + params : ""}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

// ── Main Pipeline ───────────────────────────────────────────────────────

export function analyzeEndpoints(
  entries: NetworkEntry[],
  opts?: { top?: number },
): AnalyzedEndpoint[] {
  const top = opts?.top ?? 15;
  const seen = new Map<string, AnalyzedEndpoint>();

  for (const entry of entries) {
    if (!entry.url) continue;
    if (isNoiseUrl(entry.url)) continue;
    if (isStaticResource(entry.url, entry.contentType)) continue;
    if (
      !isUsefulEndpoint({
        url: entry.url,
        status: entry.status,
        contentType: entry.contentType,
        body: entry.body,
      })
    ) {
      continue;
    }

    const pattern = urlToPattern(entry.url);
    const key = `${entry.method}:${pattern}`;
    if (seen.has(key)) continue;

    const queryParams = classifyQueryParams(entry.url);
    const responseAnalysis = entry.body
      ? analyzeResponseBody(entry.body)
      : null;
    const authIndicators = entry.requestHeaders
      ? detectAuthIndicators(entry.requestHeaders)
      : [];
    const capability = detectCapability(entry.url, entry.body);
    const sortKey = endpointSortKey({ url: entry.url, body: entry.body });

    seen.set(key, {
      url: entry.url,
      method: entry.method,
      status: entry.status,
      contentType: entry.contentType,
      body: entry.body,
      pattern,
      capability,
      sortKey,
      queryParams,
      authIndicators,
      responseAnalysis,
    });
  }

  // Sort descending by sort key
  return [...seen.values()]
    .sort((a, b) => {
      for (let i = 0; i < 4; i++) {
        if (b.sortKey[i] !== a.sortKey[i]) return b.sortKey[i] - a.sortKey[i];
      }
      return 0;
    })
    .slice(0, top);
}
