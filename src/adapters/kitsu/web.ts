/**
 * @owner   src/adapters/kitsu/web.ts
 * @does    Register Kitsu public anime and manga search commands.
 * @needs   Kitsu JSON:API text filters and public media pages.
 * @feeds   ACG title discovery with community rating and subtype metadata.
 * @breaks  Kitsu JSON:API field changes or service availability can block lookup.
 */

import { USER_AGENT } from "../../constants.js";
import { cli, Strategy } from "../../registry.js";

const API = "https://kitsu.io/api/edge";

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function required(value: unknown): string {
  const text = str(value).trim();
  if (!text) throw new Error("kitsu query cannot be empty.");
  return text;
}

function requireLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") return 10;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 20) {
    throw new Error("kitsu limit must be an integer in [1, 20].");
  }
  return n;
}

export function mapKitsuMedia(rows: unknown[]): Record<string, unknown>[] {
  return rows.map((row, index) => {
    const item = row as Record<string, unknown>;
    const attrs =
      (item.attributes as Record<string, unknown> | undefined) ?? {};
    const titles = (attrs.titles as Record<string, unknown> | undefined) ?? {};
    return {
      rank: index + 1,
      id: item.id,
      type: item.type,
      title: str(
        attrs.canonicalTitle || titles.en || titles.en_jp || titles.ja_jp,
      ),
      subtype: str(attrs.subtype),
      status: str(attrs.status),
      start_date: str(attrs.startDate),
      average_rating: str(attrs.averageRating),
      popularity_rank: attrs.popularityRank ?? null,
      synopsis: str(attrs.synopsis).slice(0, 500),
      url: `https://kitsu.io/${item.type}/${attrs.slug || item.id}`,
    };
  });
}

async function search(
  kind: "anime" | "manga",
  kwargs: Record<string, unknown>,
) {
  const query = required(kwargs.query);
  const cap = requireLimit(kwargs.limit);
  const url = new URL(`${API}/${kind}`);
  url.searchParams.set("filter[text]", query);
  url.searchParams.set("page[limit]", String(cap));
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.api+json",
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok)
    throw new Error(`kitsu request failed with HTTP ${response.status}.`);
  const data = (await response.json()) as { data?: unknown[] };
  const rows = mapKitsuMedia(data.data ?? []);
  if (rows.length === 0)
    throw new Error(`No Kitsu ${kind} found for "${query}".`);
  return rows;
}

const ARGS = [
  { name: "query", type: "str" as const, required: true, positional: true },
  { name: "limit", type: "int" as const, default: 10 },
];
const COLUMNS = [
  "rank",
  "id",
  "type",
  "title",
  "subtype",
  "status",
  "start_date",
  "average_rating",
  "url",
];

for (const name of ["anime", "manga"] as const) {
  cli({
    site: "kitsu",
    name,
    description: `Search Kitsu ${name} by Japanese title, romaji, alias, or keyword`,
    domain: "kitsu.io",
    strategy: Strategy.PUBLIC,
    browser: false,
    args: ARGS,
    columns: COLUMNS,
    func: async (_page, kwargs) => search(name, kwargs),
  });
}
