/**
 * @owner   src/adapters/jikan/web.ts
 * @does    Register Jikan public MyAnimeList search commands for anime, manga, characters, and people.
 * @needs   Jikan v4 public REST API and MAL entity URL formats.
 * @feeds   ACG title, character, and creator discovery.
 * @breaks  Jikan throttling or response field changes can block MyAnimeList-backed lookup.
 */

import { USER_AGENT } from "../../constants.js";
import { cli, Strategy } from "../../registry.js";

const API = "https://api.jikan.moe/v4";

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function required(value: unknown, label: string): string {
  const text = str(value).trim();
  if (!text) throw new Error(`jikan ${label} cannot be empty.`);
  return text;
}

function requireLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") return 10;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 25) {
    throw new Error("jikan limit must be an integer in [1, 25].");
  }
  return n;
}

function optionalYear(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1900 || n > 2100) {
    throw new Error("jikan year must be an integer in [1900, 2100].");
  }
  return n;
}

const SORTS: Record<string, { orderBy: string; direction: string }> = {
  score: { orderBy: "score", direction: "desc" },
  popularity: { orderBy: "popularity", direction: "asc" },
  recent: { orderBy: "start_date", direction: "desc" },
  relevance: { orderBy: "", direction: "" },
};

function sortSpec(value: unknown): { orderBy: string; direction: string } {
  const key = String(value ?? "relevance").trim();
  const spec = SORTS[key];
  if (!spec) {
    throw new Error(
      `jikan sort must be one of: ${Object.keys(SORTS).join(", ")}.`,
    );
  }
  return spec;
}

async function fetchJikan(
  path: string,
  query: string,
  limit: number,
  kwargs: Record<string, unknown>,
): Promise<unknown[]> {
  const url = new URL(`${API}/${path}`);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));
  if (path === "anime" || path === "manga") {
    const year = optionalYear(kwargs.year);
    if (year) {
      url.searchParams.set("start_date", `${year}-01-01`);
      url.searchParams.set("end_date", `${year}-12-31`);
    }
    const sort = sortSpec(kwargs.sort);
    if (sort.orderBy) {
      url.searchParams.set("order_by", sort.orderBy);
      url.searchParams.set("sort", sort.direction);
    }
  }
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  });
  if (!response.ok)
    throw new Error(`jikan request failed with HTTP ${response.status}.`);
  const data = (await response.json()) as { data?: unknown[] };
  return data.data ?? [];
}

export function mapJikanRows(
  rows: unknown[],
  kind: string,
): Record<string, unknown>[] {
  return rows.map((row, index) => {
    const item = row as Record<string, unknown>;
    const images = item.images as { jpg?: { image_url?: string } } | undefined;
    return {
      rank: index + 1,
      id: item.mal_id ?? null,
      kind,
      title: str(item.title ?? item.name),
      title_japanese: str(item.title_japanese ?? item.name_kanji),
      type: str(item.type),
      score: item.score ?? null,
      members: item.members ?? item.favorites ?? null,
      url: str(item.url),
      image: str(images?.jpg?.image_url),
    };
  });
}

async function search(
  kind: "anime" | "manga" | "characters" | "people",
  kwargs: Record<string, unknown>,
) {
  const query = required(kwargs.query, "query");
  const cap = requireLimit(kwargs.limit);
  const rows = mapJikanRows(await fetchJikan(kind, query, cap, kwargs), kind);
  if (rows.length === 0)
    throw new Error(`No Jikan ${kind} found for "${query}".`);
  return rows;
}

const ENTITY_ARGS = [
  { name: "query", type: "str" as const, required: true, positional: true },
  { name: "limit", type: "int" as const, default: 10 },
];
const MEDIA_ARGS = [
  { name: "query", type: "str" as const, required: true, positional: true },
  { name: "limit", type: "int" as const, default: 10 },
  { name: "year", type: "int" as const },
  {
    name: "sort",
    type: "str" as const,
    default: "relevance",
    choices: ["relevance", "score", "popularity", "recent"],
  },
];
const COLUMNS = [
  "rank",
  "id",
  "kind",
  "title",
  "title_japanese",
  "type",
  "score",
  "members",
  "url",
];

for (const name of ["anime", "manga"] as const) {
  cli({
    site: "jikan",
    name,
    description: `Search MyAnimeList ${name} through Jikan by Japanese name, romaji, or alias`,
    domain: "api.jikan.moe",
    strategy: Strategy.PUBLIC,
    browser: false,
    args: MEDIA_ARGS,
    columns: COLUMNS,
    func: async (_page, kwargs) => search(name, kwargs),
  });
}

for (const name of ["characters", "people"] as const) {
  cli({
    site: "jikan",
    name,
    description: `Search MyAnimeList ${name} through Jikan by Japanese name, romaji, or alias`,
    domain: "api.jikan.moe",
    strategy: Strategy.PUBLIC,
    browser: false,
    args: ENTITY_ARGS,
    columns: COLUMNS,
    func: async (_page, kwargs) => search(name, kwargs),
  });
}
