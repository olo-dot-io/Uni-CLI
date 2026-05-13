/**
 * @owner   src/adapters/anilist/web.ts
 * @does    Register AniList public GraphQL search commands for anime, manga, characters, staff, and studios.
 * @needs   AniList public GraphQL schema and rate-limited unauthenticated search.
 * @feeds   ACG entity discovery across titles, characters, creators, and studios.
 * @breaks  AniList GraphQL field or rate-limit changes can block search workflows.
 */

import { USER_AGENT } from "../../constants.js";
import { cli, Strategy } from "../../registry.js";

const API_URL = "https://graphql.anilist.co";

function text(value: unknown, label: string): string {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`anilist ${label} cannot be empty.`);
  return result;
}

function limit(value: unknown, fallback = 10): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new Error("anilist limit must be an integer in [1, 50].");
  }
  return n;
}

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function title(value: unknown): string {
  const obj =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return str(obj.english) || str(obj.romaji) || str(obj.native);
}

async function postGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok)
    throw new Error(`anilist request failed with HTTP ${response.status}.`);
  const data = (await response.json()) as {
    data?: T;
    errors?: Array<{ message?: string }>;
  };
  if (data.errors?.length) {
    throw new Error(
      `anilist API error: ${data.errors.map((e) => e.message).join("; ")}`,
    );
  }
  if (!data.data) throw new Error("anilist response did not include data.");
  return data.data;
}

export function mapAniListMedia(rows: unknown[]): Record<string, unknown>[] {
  return rows.map((row, index) => {
    const item = row as Record<string, unknown>;
    return {
      rank: index + 1,
      id: item.id,
      title: title(item.title),
      native: str((item.title as Record<string, unknown> | undefined)?.native),
      type: str(item.type),
      format: str(item.format),
      status: str(item.status),
      score: item.averageScore ?? null,
      popularity: item.popularity ?? null,
      episodes: item.episodes ?? null,
      chapters: item.chapters ?? null,
      url: str(item.siteUrl),
    };
  });
}

export function mapAniListNamed(
  rows: unknown[],
  kind: string,
): Record<string, unknown>[] {
  return rows.map((row, index) => {
    const item = row as Record<string, unknown>;
    const name = item.name as Record<string, unknown> | undefined;
    return {
      rank: index + 1,
      id: item.id,
      kind,
      name: str(name?.full ?? item.name),
      native: str(name?.native),
      favourites: item.favourites ?? null,
      url: str(item.siteUrl),
    };
  });
}

async function searchMedia(
  kind: "ANIME" | "MANGA",
  kwargs: Record<string, unknown>,
) {
  const query = text(kwargs.query, "query");
  const perPage = limit(kwargs.limit);
  const data = await postGraphql<{
    Page?: { media?: unknown[] };
  }>(
    `query ($search: String, $perPage: Int, $type: MediaType) {
      Page(page: 1, perPage: $perPage) {
        media(search: $search, type: $type) {
          id title { romaji english native } type format status averageScore popularity episodes chapters siteUrl
        }
      }
    }`,
    { search: query, perPage, type: kind },
  );
  const rows = mapAniListMedia(data.Page?.media ?? []);
  if (rows.length === 0)
    throw new Error(`No AniList ${kind.toLowerCase()} found for "${query}".`);
  return rows;
}

async function searchNamed(
  kind: "characters" | "staff" | "studios",
  kwargs: Record<string, unknown>,
) {
  const query = text(kwargs.query, "query");
  const perPage = limit(kwargs.limit);
  const field =
    kind === "characters"
      ? "characters"
      : kind === "staff"
        ? "staff"
        : "studios";
  const fields =
    kind === "studios"
      ? "id name favourites siteUrl"
      : "id name { full native } favourites siteUrl";
  const data = await postGraphql<{
    Page?: Record<string, unknown[]>;
  }>(
    `query ($search: String, $perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        ${field}(search: $search) { ${fields} }
      }
    }`,
    { search: query, perPage },
  );
  const rows = mapAniListNamed(data.Page?.[field] ?? [], kind);
  if (rows.length === 0)
    throw new Error(`No AniList ${kind} found for "${query}".`);
  return rows;
}

const SEARCH_ARGS = [
  { name: "query", type: "str" as const, required: true, positional: true },
  { name: "limit", type: "int" as const, default: 10 },
];

const MEDIA_COLUMNS = [
  "rank",
  "id",
  "title",
  "native",
  "type",
  "format",
  "status",
  "score",
  "popularity",
  "url",
];

const NAMED_COLUMNS = [
  "rank",
  "id",
  "kind",
  "name",
  "native",
  "favourites",
  "url",
];

cli({
  site: "anilist",
  name: "anime",
  description:
    "Search AniList anime by Japanese title, native title, romaji, alias, or keyword",
  domain: "anilist.co",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: SEARCH_ARGS,
  columns: MEDIA_COLUMNS,
  func: async (_page, kwargs) => searchMedia("ANIME", kwargs),
});

cli({
  site: "anilist",
  name: "manga",
  description:
    "Search AniList manga by Japanese title, native title, romaji, alias, or keyword",
  domain: "anilist.co",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: SEARCH_ARGS,
  columns: MEDIA_COLUMNS,
  func: async (_page, kwargs) => searchMedia("MANGA", kwargs),
});

for (const name of ["characters", "staff", "studios"] as const) {
  cli({
    site: "anilist",
    name,
    description: `Search AniList ${name} by Japanese name, native name, romaji, or alias`,
    domain: "anilist.co",
    strategy: Strategy.PUBLIC,
    browser: false,
    args: SEARCH_ARGS,
    columns: NAMED_COLUMNS,
    func: async (_page, kwargs) => searchNamed(name, kwargs),
  });
}
