/**
 * @owner   src/adapters/bangumi/web.ts
 * @does    Register Bangumi public search/detail commands for anime, books, games, and characters.
 * @needs   Bangumi public REST/search endpoints and user-agent policy.
 * @feeds   Chinese ACG title and visual-novel discovery.
 * @breaks  Bangumi legacy search endpoint or v0 subject schema changes can block lookup.
 */

import { USER_AGENT } from "../../constants.js";
import { cli, Strategy } from "../../registry.js";

const API = "https://api.bgm.tv";

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function required(value: unknown, label: string): string {
  const text = str(value).trim();
  if (!text) throw new Error(`bangumi ${label} cannot be empty.`);
  return text;
}

function requireLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") return 10;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new Error("bangumi limit must be an integer in [1, 50].");
  }
  return n;
}

const TYPE_CODES: Record<string, number> = {
  book: 1,
  anime: 2,
  music: 3,
  game: 4,
  real: 6,
};

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok)
    throw new Error(`bangumi request failed with HTTP ${response.status}.`);
  return response.json();
}

export function mapBangumiSubjects(rows: unknown[]): Record<string, unknown>[] {
  return rows.map((row, index) => {
    const item = row as Record<string, unknown>;
    const rating = item.rating as Record<string, unknown> | undefined;
    const images = item.images as Record<string, unknown> | undefined;
    return {
      rank: index + 1,
      id: item.id,
      type: item.type,
      name: str(item.name),
      name_cn: str(item.name_cn),
      date: str(item.air_date ?? item.date),
      score: rating?.score ?? null,
      rank_site: item.rank ?? null,
      summary: str(item.summary).slice(0, 500),
      image: str(images?.common),
      url: str(item.url) || `https://bgm.tv/subject/${item.id}`,
    };
  });
}

export function mapBangumiSubject(
  item: Record<string, unknown>,
): Record<string, unknown> {
  const rating = item.rating as Record<string, unknown> | undefined;
  const images = item.images as Record<string, unknown> | undefined;
  return {
    id: item.id,
    type: item.type,
    name: str(item.name),
    name_cn: str(item.name_cn),
    platform: str(item.platform),
    date: str(item.date),
    score: rating?.score ?? null,
    total_votes: rating?.total ?? null,
    rank_site: item.rank ?? null,
    summary: str(item.summary).slice(0, 1500),
    image: str(images?.common),
    url: `https://bgm.tv/subject/${item.id}`,
  };
}

async function searchSubject(
  kind: keyof typeof TYPE_CODES,
  kwargs: Record<string, unknown>,
) {
  const query = required(kwargs.query, "query");
  const cap = requireLimit(kwargs.limit);
  const url = new URL(`${API}/search/subject/${encodeURIComponent(query)}`);
  url.searchParams.set("type", String(TYPE_CODES[kind]));
  url.searchParams.set("responseGroup", "small");
  url.searchParams.set("max_results", String(cap));
  const data = (await getJson(url.toString())) as { list?: unknown[] };
  const rows = mapBangumiSubjects(data.list ?? []);
  if (rows.length === 0)
    throw new Error(`No Bangumi ${kind} found for "${query}".`);
  return rows;
}

const SEARCH_ARGS = [
  { name: "query", type: "str" as const, required: true, positional: true },
  { name: "limit", type: "int" as const, default: 10 },
];
const SUBJECT_COLUMNS = [
  "rank",
  "id",
  "type",
  "name",
  "name_cn",
  "date",
  "score",
  "rank_site",
  "url",
];

for (const name of ["anime", "book", "game"] as const) {
  cli({
    site: "bangumi",
    name,
    description: `Search Bangumi ${name} subjects by Japanese title, Chinese title, romaji, or alias`,
    domain: "bgm.tv",
    strategy: Strategy.PUBLIC,
    browser: false,
    args: SEARCH_ARGS,
    columns: SUBJECT_COLUMNS,
    func: async (_page, kwargs) => searchSubject(name, kwargs),
  });
}

cli({
  site: "bangumi",
  name: "subject",
  description: "Get Bangumi subject details by subject id",
  domain: "bgm.tv",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [{ name: "id", type: "str", required: true, positional: true }],
  columns: [
    "id",
    "type",
    "name",
    "name_cn",
    "platform",
    "date",
    "score",
    "rank_site",
    "summary",
    "url",
  ],
  func: async (_page, kwargs) => [
    mapBangumiSubject(
      (await getJson(
        `${API}/v0/subjects/${required(kwargs.id, "id")}`,
      )) as Record<string, unknown>,
    ),
  ],
});
