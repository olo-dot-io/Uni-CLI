/**
 * @owner   src/adapters/mangadex/web.ts
 * @does    Register MangaDex public manga and author search commands.
 * @needs   MangaDex public API and relationship include semantics.
 * @feeds   Manga/doujin-adjacent title and creator discovery.
 * @breaks  MangaDex API schema or public rate limits can block lookup.
 */

import { USER_AGENT } from "../../constants.js";
import { cli, Strategy } from "../../registry.js";

const API = "https://api.mangadex.org";

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function required(value: unknown, label: string): string {
  const text = str(value).trim();
  if (!text) throw new Error(`mangadex ${label} cannot be empty.`);
  return text;
}

function requireLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") return 10;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new Error("mangadex limit must be an integer in [1, 50].");
  }
  return n;
}

function optionalYear(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1900 || n > 2100) {
    throw new Error("mangadex year must be an integer in [1900, 2100].");
  }
  return n;
}

const SORT_PARAMS: Record<string, [string, string] | undefined> = {
  relevance: undefined,
  latest: ["order[latestUploadedChapter]", "desc"],
  followed: ["order[followedCount]", "desc"],
  year: ["order[year]", "desc"],
};

function applySort(url: URL, value: unknown): void {
  const key = String(value ?? "relevance").trim();
  const spec = SORT_PARAMS[key];
  if (!(key in SORT_PARAMS)) {
    throw new Error(
      `mangadex sort must be one of: ${Object.keys(SORT_PARAMS).join(", ")}.`,
    );
  }
  if (spec) url.searchParams.set(spec[0], spec[1]);
}

const CONTENT_RATINGS = new Set([
  "safe",
  "suggestive",
  "erotica",
  "pornographic",
  "all",
]);

function applyContentRating(url: URL, value: unknown): void {
  if (value === undefined || value === null || value === "") return;
  const rating = String(value).trim();
  if (!CONTENT_RATINGS.has(rating)) {
    throw new Error(
      `mangadex content_rating must be one of: ${Array.from(CONTENT_RATINGS).join(", ")}.`,
    );
  }
  if (rating !== "all") url.searchParams.append("contentRating[]", rating);
}

async function getJson(url: URL): Promise<unknown[]> {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  });
  if (!response.ok)
    throw new Error(`mangadex request failed with HTTP ${response.status}.`);
  const data = (await response.json()) as { data?: unknown[]; result?: string };
  if (data.result && data.result !== "ok")
    throw new Error(`mangadex API returned ${data.result}.`);
  return data.data ?? [];
}

function localized(values: unknown): string {
  const obj =
    values && typeof values === "object"
      ? (values as Record<string, unknown>)
      : {};
  return str(
    obj.en || obj.ja || obj["ja-ro"] || obj.zh || Object.values(obj)[0],
  );
}

export function mapMangaDexManga(rows: unknown[]): Record<string, unknown>[] {
  return rows.map((row, index) => {
    const item = row as Record<string, unknown>;
    const attrs =
      (item.attributes as Record<string, unknown> | undefined) ?? {};
    return {
      rank: index + 1,
      id: item.id,
      title: localized(attrs.title),
      status: str(attrs.status),
      year: attrs.year ?? null,
      content_rating: str(attrs.contentRating),
      latest_uploaded_chapter: str(attrs.latestUploadedChapter),
      description: localized(attrs.description).slice(0, 700),
      url: `https://mangadex.org/title/${item.id}`,
    };
  });
}

export function mapMangaDexAuthors(rows: unknown[]): Record<string, unknown>[] {
  return rows.map((row, index) => {
    const item = row as Record<string, unknown>;
    const attrs =
      (item.attributes as Record<string, unknown> | undefined) ?? {};
    return {
      rank: index + 1,
      id: item.id,
      name: str(attrs.name),
      twitter: str(attrs.twitter),
      pixiv: str(attrs.pixiv),
      website: str(attrs.website),
      url: `https://mangadex.org/author/${item.id}`,
    };
  });
}

async function searchManga(kwargs: Record<string, unknown>) {
  const query = required(kwargs.query, "query");
  const url = new URL(`${API}/manga`);
  url.searchParams.set("title", query);
  url.searchParams.set("limit", String(requireLimit(kwargs.limit)));
  const year = optionalYear(kwargs.year);
  if (year) url.searchParams.set("year", String(year));
  applySort(url, kwargs.sort);
  applyContentRating(url, kwargs["content-rating"]);
  url.searchParams.append("includes[]", "author");
  url.searchParams.append("includes[]", "artist");
  const rows = mapMangaDexManga(await getJson(url));
  if (rows.length === 0)
    throw new Error(`No MangaDex manga found for "${query}".`);
  return rows;
}

async function searchAuthors(kwargs: Record<string, unknown>) {
  const query = required(kwargs.query, "query");
  const url = new URL(`${API}/author`);
  url.searchParams.set("name", query);
  url.searchParams.set("limit", String(requireLimit(kwargs.limit)));
  const rows = mapMangaDexAuthors(await getJson(url));
  if (rows.length === 0)
    throw new Error(`No MangaDex authors found for "${query}".`);
  return rows;
}

const SEARCH_ARGS = [
  { name: "query", type: "str" as const, required: true, positional: true },
  { name: "limit", type: "int" as const, default: 10 },
];

const MANGA_ARGS = [
  { name: "query", type: "str" as const, required: true, positional: true },
  { name: "limit", type: "int" as const, default: 10 },
  { name: "year", type: "int" as const },
  {
    name: "sort",
    type: "str" as const,
    default: "relevance",
    choices: ["relevance", "latest", "followed", "year"],
  },
  {
    name: "content-rating",
    type: "str" as const,
    choices: ["safe", "suggestive", "erotica", "pornographic", "all"],
  },
];

cli({
  site: "mangadex",
  name: "manga",
  description:
    "Search MangaDex manga by Japanese title, romaji, alias, or keyword",
  domain: "mangadex.org",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: MANGA_ARGS,
  columns: ["rank", "id", "title", "status", "year", "content_rating", "url"],
  func: async (_page, kwargs) => searchManga(kwargs),
});

cli({
  site: "mangadex",
  name: "authors",
  description: "Search MangaDex authors and artists by public name or romaji",
  domain: "mangadex.org",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: SEARCH_ARGS,
  columns: ["rank", "id", "name", "twitter", "pixiv", "website", "url"],
  func: async (_page, kwargs) => searchAuthors(kwargs),
});
