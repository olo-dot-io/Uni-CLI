/**
 * @owner       src::adapters::crossref::works
 * @does        Registers Crossref REST work search and DOI lookup commands for publisher metadata.
 * @needs       api.crossref.org REST API, optional CROSSREF_MAILTO, src/registry.ts
 * @feeds       src/commands/scholar.ts via scholar.search and scholar.get
 * @breaks      Crossref response-shape drift or rate limiting surfaces as explicit adapter errors.
 * @invariants  DOI lookup accepts only DOI-shaped references; output maps to ScholarlyWorkRecord.
 * @side-effects HTTPS egress to api.crossref.org only
 * @perf        O(limit) JSON mapping
 * @concurrency safe
 * @test        tests/unit/adapters/scholar-sources.test.ts
 * @stability   experimental
 * @since       2026-05-19
 */

import { cli, Strategy } from "../../registry.js";
import type { ScholarlyWorkRecord } from "../../types/scholarly.js";

const API = "https://api.crossref.org";

interface CrossrefPerson {
  given?: unknown;
  family?: unknown;
  name?: unknown;
}

interface CrossrefItem {
  DOI?: unknown;
  title?: unknown[];
  subtitle?: unknown[];
  author?: CrossrefPerson[];
  "container-title"?: unknown[];
  issued?: { "date-parts"?: unknown[][] };
  published?: { "date-parts"?: unknown[][] };
  "is-referenced-by-count"?: unknown;
  reference?: unknown[];
  URL?: unknown;
  type?: unknown;
  abstract?: unknown;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function arrFirst(value: unknown): string {
  return Array.isArray(value) ? str(value[0]) : str(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function dateParts(item: CrossrefItem): unknown[] {
  return (
    item.issued?.["date-parts"]?.[0] ??
    item.published?.["date-parts"]?.[0] ??
    []
  );
}

function year(item: CrossrefItem): number | undefined {
  const first = dateParts(item)[0];
  return typeof first === "number" && Number.isFinite(first)
    ? first
    : undefined;
}

function date(item: CrossrefItem): string | undefined {
  const parts = dateParts(item).filter(
    (part): part is number => typeof part === "number",
  );
  if (parts.length === 0) return undefined;
  return [
    String(parts[0]).padStart(4, "0"),
    String(parts[1] ?? 1).padStart(2, "0"),
    String(parts[2] ?? 1).padStart(2, "0"),
  ].join("-");
}

function authors(value: CrossrefPerson[] | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map(
      (person) =>
        str(person.name) ||
        [person.given, person.family].map(str).filter(Boolean).join(" "),
    )
    .filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function bareDoi(value: unknown): string {
  return str(value)
    .replace(/^doi:/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
}

export function requireCrossrefDoi(value: unknown): string {
  const doi = bareDoi(value);
  if (!/^10\.\S+\/\S+/.test(doi)) {
    throw new Error(`crossref DOI "${String(value ?? "")}" is not recognised.`);
  }
  return doi;
}

function maybeMailto(params: URLSearchParams): void {
  const mailto = process.env.CROSSREF_MAILTO?.trim();
  if (mailto) params.set("mailto", mailto);
}

async function fetchCrossref(path: string, label: string): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    headers: {
      Accept: "application/json",
      "User-Agent":
        "unicli-crossref/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
    },
  });
  if (response.status === 404) throw new Error(`${label} returned no result.`);
  if (response.status === 429) throw new Error(`${label} returned HTTP 429.`);
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}.`);
  return response.json();
}

export function mapCrossrefItem(
  item: CrossrefItem,
  source: string,
): ScholarlyWorkRecord {
  const doi = requireCrossrefDoi(item.DOI);
  return {
    id: doi,
    title: arrFirst(item.title),
    authors: authors(item.author),
    year: year(item),
    date: date(item),
    venue: arrFirst(item["container-title"]) || undefined,
    type: str(item.type) || undefined,
    abstract: str(item.abstract).replace(/<[^>]+>/g, " ") || undefined,
    doi,
    cited_by_count: num(item["is-referenced-by-count"]),
    references_count: Array.isArray(item.reference)
      ? item.reference.length
      : undefined,
    source_adapter: source,
    source_url: str(item.URL) || `https://doi.org/${doi}`,
    retrieved_at: new Date().toISOString(),
  };
}

cli({
  site: "crossref",
  name: "search",
  description:
    "Search Crossref Works by title, author, DOI, or bibliographic text",
  domain: "api.crossref.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["id", "title", "authors", "year", "venue", "doi", "source_url"],
  capabilities: ["http.fetch", "scholar.search"],
  func: async (_page, kwargs) => {
    const query = String(kwargs.query ?? "").trim();
    if (!query) throw new Error("crossref search query cannot be empty.");
    const limit = Math.min(Math.max(Number(kwargs.limit ?? 20), 1), 100);
    const params = new URLSearchParams({ query, rows: String(limit) });
    maybeMailto(params);
    const body = (await fetchCrossref(
      `/works?${params.toString()}`,
      "crossref search",
    )) as {
      message?: { items?: CrossrefItem[] };
    };
    const rows = (body.message?.items ?? []).map((item) =>
      mapCrossrefItem(item, "crossref"),
    );
    if (rows.length === 0)
      throw new Error(`No Crossref works matched "${query}".`);
    return rows;
  },
});

cli({
  site: "crossref",
  name: "work",
  description: "Fetch one Crossref Work by DOI",
  domain: "api.crossref.org",
  strategy: Strategy.PUBLIC,
  args: [{ name: "doi", type: "str", required: true, positional: true }],
  columns: ["id", "title", "authors", "year", "venue", "doi", "source_url"],
  capabilities: ["http.fetch", "scholar.get"],
  func: async (_page, kwargs) => {
    const doi = requireCrossrefDoi(kwargs.doi ?? kwargs.id ?? kwargs.ref);
    const params = new URLSearchParams();
    maybeMailto(params);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    const body = (await fetchCrossref(
      `/works/${encodeURIComponent(doi)}${suffix}`,
      `crossref work ${doi}`,
    )) as { message?: CrossrefItem };
    if (!body.message) throw new Error(`Crossref returned no work for ${doi}.`);
    return [mapCrossrefItem(body.message, "crossref")];
  },
});
