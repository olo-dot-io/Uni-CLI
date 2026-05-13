/**
 * @owner   src/adapters/vndb/web.ts
 * @does    Register VNDB public visual novel, release, tag, staff, producer, and character lookup commands.
 * @needs   VNDB Kana API JSON contract and public unauthenticated read endpoints.
 * @feeds   ACG research workflows, visual novel discovery, game tag/type search.
 * @breaks  VNDB field names or filter semantics drifting will hide games or metadata.
 */

import { USER_AGENT } from "../../constants.js";
import { cli, Strategy } from "../../registry.js";

const VNDB_API = "https://api.vndb.org/kana";

interface VndbResponse {
  more?: boolean;
  results?: Record<string, unknown>[];
}

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function requireQuery(value: unknown): string {
  const query = str(value).trim();
  if (!query) throw new Error("VNDB query cannot be empty.");
  return query;
}

function requireLimit(value: unknown, fallback = 20): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new Error("VNDB limit must be an integer in [1, 100].");
  }
  return n;
}

function normalizeId(value: unknown, prefix: string): string {
  const raw = str(value).trim().toLowerCase();
  if (!raw) throw new Error("VNDB id cannot be empty.");
  return raw.startsWith(prefix) ? raw : `${prefix}${raw}`;
}

function joinNames(value: unknown, key = "name"): string {
  return Array.isArray(value)
    ? value
        .map((item) => str((item as Record<string, unknown>)[key]))
        .join(", ")
    : "";
}

function joinStrings(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join(", ") : str(value);
}

function firstUrl(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  return str((value as Record<string, unknown>).url);
}

function tagSummary(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .slice()
    .sort(
      (a, b) =>
        Number((b as Record<string, unknown>).rating ?? 0) -
        Number((a as Record<string, unknown>).rating ?? 0),
    )
    .slice(0, 12)
    .map((item) => str((item as Record<string, unknown>).name))
    .filter(Boolean)
    .join(", ");
}

function sortValue(value: unknown, allowed: Record<string, string>): string {
  const key = str(value || "relevance")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  const mapped = allowed[key];
  if (!mapped) {
    throw new Error(
      `Unsupported VNDB sort: ${value}. Supported: ${Object.keys(allowed).join(", ")}.`,
    );
  }
  return mapped;
}

async function vndbPost(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${VNDB_API}/${endpoint}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `VNDB ${endpoint} request failed with HTTP ${response.status}.`,
    );
  }
  const json = (await response.json()) as VndbResponse;
  return json.results ?? [];
}

function rankRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row, index) => ({ rank: index + 1, ...row }));
}

export function mapVndbVisualNovels(
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  return rankRows(
    rows.map((item) => ({
      id: str(item.id),
      title: str(item.title),
      alttitle: str(item.alttitle),
      released: str(item.released),
      languages: joinStrings(item.languages),
      platforms: joinStrings(item.platforms),
      rating: item.rating ?? "",
      votecount: item.votecount ?? "",
      developers: joinNames(item.developers),
      tags: tagSummary(item.tags),
      image: firstUrl(item.image),
      url: `https://vndb.org/${str(item.id)}`,
    })),
  );
}

export function mapVndbReleases(
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  return rankRows(
    rows.map((item) => ({
      id: str(item.id),
      title: str(item.title),
      released: str(item.released),
      platforms: joinStrings(item.platforms),
      producers: joinNames(item.producers),
      vns: joinNames(item.vns, "title"),
      url: `https://vndb.org/${str(item.id)}`,
    })),
  );
}

function mapSimple(
  rows: Record<string, unknown>[],
  urlPrefix: string,
): Record<string, unknown>[] {
  return rankRows(
    rows.map((item) => ({
      id: str(item.id),
      name: str(item.name),
      original: str(item.original),
      category: str(item.category),
      type: str(item.type),
      lang: str(item.lang),
      aliases: joinStrings(item.aliases),
      description: str(item.description).replace(/\s+/g, " ").slice(0, 500),
      url: `https://vndb.org/${urlPrefix}${str(item.id).replace(/^[a-z]+/, "")}`,
    })),
  );
}

async function searchVn(kwargs: Record<string, unknown>) {
  const sort = sortValue(kwargs.sort, {
    relevance: "searchrank",
    rating: "rating",
    votes: "votecount",
    votecount: "votecount",
    released: "released",
    time: "released",
    title: "title",
  });
  const rows = await vndbPost("vn", {
    filters: ["search", "=", requireQuery(kwargs.query)],
    fields:
      "id,title,alttitle,released,languages,platforms,rating,votecount,image.url,tags.rating,tags.name,tags.category,developers.name",
    sort,
    reverse: kwargs.reverse === true,
    results: requireLimit(kwargs.limit),
  });
  return mapVndbVisualNovels(rows);
}

const VN_COLUMNS = [
  "rank",
  "id",
  "title",
  "alttitle",
  "released",
  "languages",
  "platforms",
  "rating",
  "votecount",
  "developers",
  "tags",
  "url",
];

cli({
  site: "vndb",
  name: "search",
  description: "Search VNDB visual novels by title, alias, tag, or keyword",
  domain: "api.vndb.org",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
    {
      name: "sort",
      type: "str",
      default: "relevance",
      description: "relevance, rating, votes, released, time, title",
    },
    { name: "reverse", type: "bool", default: false },
  ],
  columns: VN_COLUMNS,
  func: async (_page, kwargs) => searchVn(kwargs),
});

cli({
  site: "vndb",
  name: "vn",
  description: "Get VNDB visual novel details by v-id",
  domain: "api.vndb.org",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [{ name: "id", type: "str", required: true, positional: true }],
  columns: VN_COLUMNS,
  func: async (_page, kwargs) =>
    mapVndbVisualNovels(
      await vndbPost("vn", {
        filters: ["id", "=", normalizeId(kwargs.id, "v")],
        fields:
          "id,title,alttitle,released,languages,platforms,rating,votecount,image.url,tags.rating,tags.name,tags.category,developers.name",
        results: 1,
      }),
    ),
});

cli({
  site: "vndb",
  name: "releases",
  description: "Search VNDB releases by title or visual novel keyword",
  domain: "api.vndb.org",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
    {
      name: "sort",
      type: "str",
      default: "released",
      description: "released, time, title",
    },
    { name: "reverse", type: "bool", default: true },
  ],
  columns: [
    "rank",
    "id",
    "title",
    "released",
    "platforms",
    "producers",
    "vns",
    "url",
  ],
  func: async (_page, kwargs) =>
    mapVndbReleases(
      await vndbPost("release", {
        filters: ["search", "=", requireQuery(kwargs.query)],
        fields: "id,title,released,platforms,producers.name,vns.title",
        sort: sortValue(kwargs.sort, {
          released: "released",
          time: "released",
          title: "title",
        }),
        reverse: kwargs.reverse !== false,
        results: requireLimit(kwargs.limit),
      }),
    ),
});

cli({
  site: "vndb",
  name: "tags",
  description: "Search VNDB game tags and genres",
  domain: "api.vndb.org",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["rank", "id", "name", "category", "description", "url"],
  func: async (_page, kwargs) =>
    mapSimple(
      await vndbPost("tag", {
        filters: ["search", "=", requireQuery(kwargs.query)],
        fields: "id,name,category,description",
        results: requireLimit(kwargs.limit),
      }),
      "g",
    ),
});

cli({
  site: "vndb",
  name: "staff",
  description: "Search VNDB creators and staff",
  domain: "api.vndb.org",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["rank", "id", "name", "original", "lang", "description", "url"],
  func: async (_page, kwargs) =>
    mapSimple(
      await vndbPost("staff", {
        filters: ["search", "=", requireQuery(kwargs.query)],
        fields: "id,name,original,lang,gender,description",
        results: requireLimit(kwargs.limit),
      }),
      "s",
    ),
});

cli({
  site: "vndb",
  name: "producers",
  description:
    "Search VNDB producers, studios, brands, makers, circles, companies, and visual novel publishers such as Yuzusoft",
  domain: "api.vndb.org",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: [
    "rank",
    "id",
    "name",
    "aliases",
    "lang",
    "type",
    "description",
    "url",
  ],
  func: async (_page, kwargs) =>
    mapSimple(
      await vndbPost("producer", {
        filters: ["search", "=", requireQuery(kwargs.query)],
        fields: "id,name,aliases,lang,type,description",
        results: requireLimit(kwargs.limit),
      }),
      "p",
    ),
});

cli({
  site: "vndb",
  name: "characters",
  description: "Search VNDB characters and traits",
  domain: "api.vndb.org",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["rank", "id", "name", "original", "description", "url"],
  func: async (_page, kwargs) =>
    mapSimple(
      await vndbPost("character", {
        filters: ["search", "=", requireQuery(kwargs.query)],
        fields: "id,name,original,sex,description,vns.title,traits.name",
        results: requireLimit(kwargs.limit),
      }),
      "c",
    ),
});
