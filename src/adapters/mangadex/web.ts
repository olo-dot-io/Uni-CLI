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

const ARGS = [
  { name: "query", type: "str" as const, required: true, positional: true },
  { name: "limit", type: "int" as const, default: 10 },
];

cli({
  site: "mangadex",
  name: "manga",
  description:
    "Search MangaDex manga by Japanese title, romaji, alias, or keyword",
  domain: "mangadex.org",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: ARGS,
  columns: ["rank", "id", "title", "status", "year", "content_rating", "url"],
  func: async (_page, kwargs) => searchManga(kwargs),
});

cli({
  site: "mangadex",
  name: "authors",
  description: "Search MangaDex authors and artists by Japanese name or romaji",
  domain: "mangadex.org",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: ARGS,
  columns: ["rank", "id", "name", "twitter", "pixiv", "website", "url"],
  func: async (_page, kwargs) => searchAuthors(kwargs),
});
