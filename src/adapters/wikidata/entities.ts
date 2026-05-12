/**
 * @owner   src/adapters/wikidata/entities.ts
 * @does    Register agent-facing Wikidata entity search and detail commands.
 * @needs   Wikidata public APIs, language validation, Q/P/L entity id validation.
 * @feeds   surface coverage ledger, Wikidata search rows, entity summary rows.
 * @breaks  Wikidata API drift, weak id validation, or silent empty rows hide entity lookup failures.
 */

import { cli, Strategy } from "../../registry.js";

const API_BASE = "https://www.wikidata.org";
const ENTITY_ID_RE = /^[QPL]\d+$/;

function requireNonEmpty(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`wikidata ${label} cannot be empty.`);
  return text;
}

export function requireWikidataLimit(value: unknown): number {
  const raw =
    value === undefined || value === null || value === "" ? 20 : value;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("wikidata limit must be an integer in [1, 50].");
  }
  return limit;
}

export function requireWikidataLanguage(value: unknown): string {
  const language = String(value ?? "en")
    .trim()
    .toLowerCase();
  if (!/^[a-z]{2,3}(-[a-z]{2,8})?$/.test(language)) {
    throw new Error(`wikidata language "${String(value)}" is not valid.`);
  }
  return language;
}

export function requireWikidataEntityId(value: unknown): string {
  const raw = String(value ?? "")
    .trim()
    .toUpperCase();
  if (!raw) throw new Error("wikidata entity id cannot be empty.");
  const id = raw.replace(/^HTTPS?:\/\/[^/]+\/WIKI\//i, "");
  if (!ENTITY_ID_RE.test(id)) {
    throw new Error(`wikidata entity id "${String(value)}" is not valid.`);
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

export function pickLocalizedValue(
  map: unknown,
  language: string,
): string | null {
  const values = objectField(map);
  const direct = objectField(values[language]);
  if (stringField(direct.value)) return stringField(direct.value);
  const english = objectField(values.en);
  return stringField(english.value) || null;
}

export function joinLocalizedAliases(
  value: unknown,
  language: string,
  max = 5,
): string {
  const aliases = objectField(value);
  const direct = Array.isArray(aliases[language]) ? aliases[language] : [];
  const fallback = Array.isArray(aliases.en) ? aliases.en : [];
  const list = direct.length > 0 ? direct : fallback;
  const names = list
    .map((item) => stringField(objectField(item).value))
    .filter(Boolean);
  return names.length > max
    ? [...names.slice(0, max), `(+${names.length - max})`].join(", ")
    : names.join(", ");
}

export function mapWikidataSearchRows(
  rows: Array<Record<string, unknown>>,
  limit: number,
): Array<Record<string, unknown>> {
  return rows.slice(0, limit).map((row, index) => {
    const qid = stringField(row.id);
    const match = objectField(row.match);
    return {
      rank: index + 1,
      qid,
      label: stringField(row.label),
      description: stringField(row.description),
      matchType: stringField(match.type),
      matchText: stringField(match.text),
      url: qid ? `${API_BASE}/wiki/${qid}` : "",
    };
  });
}

export function mapWikidataEntityRow(
  id: string,
  entity: Record<string, unknown>,
  language: string,
): Record<string, unknown> {
  const claims = objectField(entity.claims);
  const sitelinks = objectField(entity.sitelinks);
  const enwiki = objectField(sitelinks.enwiki);
  return {
    qid: id,
    type: stringField(entity.type),
    label: pickLocalizedValue(entity.labels, language),
    description: pickLocalizedValue(entity.descriptions, language),
    aliases: joinLocalizedAliases(entity.aliases, language),
    claimPropertyCount: Object.keys(claims).length,
    sitelinkCount: Object.keys(sitelinks).length,
    enwikiTitle: stringField(enwiki.title) || null,
    modified: stringField(entity.modified) || null,
    url: `${API_BASE}/wiki/${id}`,
  };
}

async function fetchJson(url: URL | string, label: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "unicli-wikidata (https://github.com/olo-dot-io/Uni-CLI)",
    },
  });
  if (response.status === 404) throw new Error(`${label} returned no result.`);
  if (response.status === 429) throw new Error(`${label} returned HTTP 429.`);
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}.`);
  return response.json();
}

cli({
  site: "wikidata",
  name: "search",
  description: "Search Wikidata items by keyword",
  domain: "www.wikidata.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "Search keyword",
    },
    {
      name: "language",
      type: "str",
      default: "en",
      description: "Language code",
    },
    { name: "limit", type: "int", default: 20, description: "Max rows" },
  ],
  columns: [
    "rank",
    "qid",
    "label",
    "description",
    "matchType",
    "matchText",
    "url",
  ],
  func: async (_page, kwargs) => {
    const query = requireNonEmpty(kwargs.query, "query");
    const language = requireWikidataLanguage(kwargs.language);
    const limit = requireWikidataLimit(kwargs.limit);
    const url = new URL(`${API_BASE}/w/api.php`);
    url.searchParams.set("action", "wbsearchentities");
    url.searchParams.set("search", query);
    url.searchParams.set("language", language);
    url.searchParams.set("uselang", language);
    url.searchParams.set("type", "item");
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("origin", "*");
    const body = (await fetchJson(url, "wikidata search")) as {
      search?: unknown;
    };
    const rows = mapWikidataSearchRows(
      Array.isArray(body.search)
        ? (body.search as Array<Record<string, unknown>>)
        : [],
      limit,
    );
    if (rows.length === 0) {
      throw new Error(`wikidata search returned no rows for "${query}".`);
    }
    return rows;
  },
});

cli({
  site: "wikidata",
  name: "entity",
  description: "Fetch a Wikidata entity by Q/P/L id",
  domain: "www.wikidata.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "id",
      type: "str",
      required: true,
      positional: true,
      description: "Entity id",
    },
    {
      name: "language",
      type: "str",
      default: "en",
      description: "Language code",
    },
  ],
  columns: [
    "qid",
    "type",
    "label",
    "description",
    "aliases",
    "claimPropertyCount",
    "sitelinkCount",
    "enwikiTitle",
    "modified",
    "url",
  ],
  func: async (_page, kwargs) => {
    const id = requireWikidataEntityId(kwargs.id);
    const language = requireWikidataLanguage(kwargs.language);
    const body = objectField(
      await fetchJson(
        `${API_BASE}/wiki/Special:EntityData/${encodeURIComponent(id)}.json`,
        "wikidata entity",
      ),
    );
    const entity = objectField(objectField(body.entities)[id]);
    if (!entity.id && !entity.type) {
      throw new Error(`wikidata entity returned no row for "${id}".`);
    }
    return [mapWikidataEntityRow(id, entity, language)];
  },
});
