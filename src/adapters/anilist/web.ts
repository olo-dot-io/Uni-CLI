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

function optionalYear(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1900 || n > 2100) {
    throw new Error("anilist year must be an integer in [1900, 2100].");
  }
  return n;
}

const MEDIA_SORTS: Record<string, string[]> = {
  popular: ["POPULARITY_DESC"],
  trending: ["TRENDING_DESC"],
  recent: ["START_DATE_DESC"],
  score: ["SCORE_DESC"],
  relevance: ["SEARCH_MATCH"],
};

function mediaSort(value: unknown): string[] {
  const key = String(value ?? "relevance").trim();
  const sort = MEDIA_SORTS[key];
  if (!sort) {
    throw new Error(
      `anilist sort must be one of: ${Object.keys(MEDIA_SORTS).join(", ")}.`,
    );
  }
  return sort;
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
      trending: item.trending ?? null,
      start_date: formatDate(item.startDate),
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

export function rerankAniListNamed(rows: unknown[], query: string): unknown[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;

  return [...rows].sort((left, right) => {
    const leftScore = namedMatchScore(left, needle);
    const rightScore = namedMatchScore(right, needle);
    if (leftScore !== rightScore) return rightScore - leftScore;
    return 0;
  });
}

function namedMatchScore(row: unknown, needle: string): number {
  const item = row as Record<string, unknown>;
  const name =
    item.name && typeof item.name === "object"
      ? (item.name as Record<string, unknown>)
      : {};
  const candidates = [item.name, name.full, name.native].map((value) =>
    str(value).toLowerCase(),
  );
  if (candidates.some((value) => value === needle)) return 4;
  if (candidates.some((value) => value.includes(needle))) return 3;
  if (candidates.some((value) => needle.includes(value) && value.length > 1)) {
    return 2;
  }
  return 0;
}

function formatDate(value: unknown): string {
  const obj =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const year = Number(obj.year);
  if (!Number.isInteger(year) || year <= 0) return "";
  const month = Number(obj.month);
  const day = Number(obj.day);
  if (!Number.isInteger(month) || month <= 0) return String(year);
  if (!Number.isInteger(day) || day <= 0) {
    return [String(year).padStart(4, "0"), String(month).padStart(2, "0")].join(
      "-",
    );
  }
  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0"),
  ].join("-");
}

async function searchMedia(
  kind: "ANIME" | "MANGA",
  kwargs: Record<string, unknown>,
) {
  const query = text(kwargs.query, "query");
  const requested = limit(kwargs.limit);
  const perPage = Math.min(50, Math.max(10, requested * 5));
  const year = optionalYear(kwargs.year);
  const startDateGreater = year ? year * 10000 + 101 : undefined;
  const startDateLesser = year ? year * 10000 + 1231 : undefined;
  const sort = mediaSort(kwargs.sort);
  const data = await postGraphql<{
    Page?: { media?: unknown[] };
  }>(
    `query ($search: String, $perPage: Int, $type: MediaType, $startDateGreater: FuzzyDateInt, $startDateLesser: FuzzyDateInt, $sort: [MediaSort]) {
      Page(page: 1, perPage: $perPage) {
        media(search: $search, type: $type, startDate_greater: $startDateGreater, startDate_lesser: $startDateLesser, sort: $sort) {
          id title { romaji english native } type format status averageScore popularity trending startDate { year month day } episodes chapters siteUrl
        }
      }
    }`,
    {
      search: query,
      perPage,
      type: kind,
      startDateGreater,
      startDateLesser,
      sort,
    },
  );
  const rows = mapAniListMedia((data.Page?.media ?? []).slice(0, requested));
  if (rows.length === 0)
    throw new Error(`No AniList ${kind.toLowerCase()} found for "${query}".`);
  return rows;
}

async function searchNamed(
  kind: "characters" | "staff" | "studios",
  kwargs: Record<string, unknown>,
) {
  const query = text(kwargs.query, "query");
  const requested = limit(kwargs.limit);
  const perPage = Math.min(50, Math.max(10, requested * 5));
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
  const rows = mapAniListNamed(
    rerankAniListNamed(data.Page?.[field] ?? [], query).slice(0, requested),
    kind,
  );
  if (rows.length === 0)
    throw new Error(`No AniList ${kind} found for "${query}".`);
  return rows;
}

const MEDIA_ARGS = [
  { name: "query", type: "str" as const, required: true, positional: true },
  { name: "limit", type: "int" as const, default: 10 },
  { name: "year", type: "int" as const },
  {
    name: "sort",
    type: "str" as const,
    default: "relevance",
    choices: ["relevance", "popular", "trending", "recent", "score"],
  },
];

const NAMED_ARGS = [
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
  "trending",
  "start_date",
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
  args: MEDIA_ARGS,
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
  args: MEDIA_ARGS,
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
    args: NAMED_ARGS,
    columns: NAMED_COLUMNS,
    func: async (_page, kwargs) => searchNamed(name, kwargs),
  });
}
