/**
 * @owner   src/adapters/tvmaze/shows.ts
 * @does    Register agent-facing TVmaze show search and detail commands.
 * @needs   TVmaze public API, bounded search limits, positive show ids.
 * @feeds   surface coverage ledger, TV show reference rows, cross-reference ids.
 * @breaks  TVmaze API drift, weak id validation, or silent empty rows hide show lookup failures.
 */

import { cli, Strategy } from "../../registry.js";

const API_BASE = "https://api.tvmaze.com";

function requireNonEmpty(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`tvmaze ${label} cannot be empty.`);
  return text;
}

export function requireTvmazeLimit(value: unknown): number {
  const raw =
    value === undefined || value === null || value === "" ? 20 : value;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("tvmaze limit must be an integer in [1, 50].");
  }
  return limit;
}

export function requireTvmazeShowId(value: unknown): number {
  const id = Number(String(value ?? "").trim());
  if (!Number.isInteger(id) || id < 1) {
    throw new Error("tvmaze show id must be a positive integer.");
  }
  return id;
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberField(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(n) ? n : null;
}

function joinList(value: unknown): string {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).join(", ")
    : "";
}

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

export function stripTvmazeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_match, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(
      /&([a-zA-Z]+);/g,
      (match, name: string) => HTML_ENTITY_MAP[name] ?? match,
    )
    .replace(/\s+/g, " ")
    .trim();
}

function networkName(show: Record<string, unknown>): string {
  const network = objectField(show.network);
  const webChannel = objectField(show.webChannel);
  return stringField(network.name) || stringField(webChannel.name);
}

function countryName(show: Record<string, unknown>): string {
  const networkCountry = objectField(objectField(show.network).country);
  const webCountry = objectField(objectField(show.webChannel).country);
  return stringField(networkCountry.name) || stringField(webCountry.name);
}

function ratingAverage(show: Record<string, unknown>): number | null {
  return numberField(objectField(show.rating).average);
}

export function mapTvmazeSearchRows(
  entries: Array<Record<string, unknown>>,
  limit: number,
): Array<Record<string, unknown>> {
  return entries.slice(0, limit).map((entry, index) => {
    const show = objectField(entry.show);
    return {
      rank: index + 1,
      id: numberField(show.id),
      name: stringField(show.name),
      type: stringField(show.type),
      language: stringField(show.language),
      genres: joinList(show.genres),
      status: stringField(show.status),
      premiered: stringField(show.premiered),
      ended: stringField(show.ended),
      network: networkName(show),
      rating: ratingAverage(show),
      matchScore: numberField(entry.score),
      summary: stripTvmazeHtml(show.summary),
      url: stringField(show.url),
    };
  });
}

export function mapTvmazeShowRow(
  show: Record<string, unknown>,
): Record<string, unknown> {
  const schedule = objectField(show.schedule);
  const days = joinList(schedule.days);
  const time = stringField(schedule.time);
  const externals = objectField(show.externals);
  return {
    id: numberField(show.id),
    name: stringField(show.name),
    type: stringField(show.type),
    language: stringField(show.language),
    genres: joinList(show.genres),
    status: stringField(show.status),
    premiered: stringField(show.premiered),
    ended: stringField(show.ended),
    runtime: numberField(show.runtime),
    averageRuntime: numberField(show.averageRuntime),
    network: networkName(show),
    country: countryName(show),
    schedule:
      days || time ? `${days}${days && time ? " " : ""}${time}`.trim() : "",
    rating: ratingAverage(show),
    imdb: stringField(externals.imdb),
    thetvdb: numberField(externals.thetvdb),
    officialSite: stringField(show.officialSite),
    summary: stripTvmazeHtml(show.summary),
    url: stringField(show.url),
  };
}

async function fetchJson(url: URL | string, label: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "unicli-tvmaze (https://github.com/olo-dot-io/Uni-CLI)",
    },
  });
  if (response.status === 404) throw new Error(`${label} returned no result.`);
  if (response.status === 429) throw new Error(`${label} returned HTTP 429.`);
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}.`);
  return response.json();
}

cli({
  site: "tvmaze",
  name: "search",
  description: "Search TVmaze shows by title",
  domain: "tvmaze.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "TV show title or fragment",
    },
    { name: "limit", type: "int", default: 20, description: "Max rows" },
  ],
  columns: [
    "rank",
    "id",
    "name",
    "type",
    "language",
    "genres",
    "status",
    "premiered",
    "ended",
    "network",
    "rating",
    "matchScore",
    "summary",
    "url",
  ],
  func: async (_page, kwargs) => {
    const query = requireNonEmpty(kwargs.query, "query");
    const limit = requireTvmazeLimit(kwargs.limit);
    const url = new URL(`${API_BASE}/search/shows`);
    url.searchParams.set("q", query);
    const body = await fetchJson(url, "tvmaze search");
    const rows = mapTvmazeSearchRows(
      Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [],
      limit,
    );
    if (rows.length === 0) {
      throw new Error(`tvmaze search returned no rows for "${query}".`);
    }
    return rows;
  },
});

cli({
  site: "tvmaze",
  name: "show",
  description: "Fetch TVmaze show detail by id",
  domain: "tvmaze.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "id",
      type: "int",
      required: true,
      positional: true,
      description: "TVmaze show id",
    },
  ],
  columns: [
    "id",
    "name",
    "type",
    "language",
    "genres",
    "status",
    "premiered",
    "ended",
    "runtime",
    "averageRuntime",
    "network",
    "country",
    "schedule",
    "rating",
    "imdb",
    "thetvdb",
    "officialSite",
    "summary",
    "url",
  ],
  func: async (_page, kwargs) => {
    const id = requireTvmazeShowId(kwargs.id);
    const body = objectField(
      await fetchJson(`${API_BASE}/shows/${id}`, "tvmaze show"),
    );
    if (body.id == null)
      throw new Error(`tvmaze show returned no row for id ${id}.`);
    return [mapTvmazeShowRow(body)];
  },
});
