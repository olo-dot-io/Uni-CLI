/**
 * @owner   src/adapters/openalex/works.ts
 * @does    Register agent-facing OpenAlex work search and detail commands.
 * @needs   Public OpenAlex API, TypeScript adapter loader, work id/DOI normalization.
 * @feeds   surface coverage ledger, scholarly work command surface, agent-readable OpenAlex rows.
 * @breaks  OpenAlex API envelope drift, weak DOI/id parsing, or abstract reconstruction errors degrade research lookup.
 */

import { cli, Strategy } from "../../registry.js";

const OPENALEX_BASE = "https://api.openalex.org";
const WORK_ID_RE = /^W\d{4,}$/;
const DOI_RE = /^10\.\S+$/;
const SEARCH_SELECT = [
  "id",
  "doi",
  "title",
  "publication_year",
  "cited_by_count",
  "authorships",
  "primary_location",
  "open_access",
  "type",
].join(",");
const WORK_SELECT = [
  "id",
  "doi",
  "title",
  "publication_year",
  "publication_date",
  "cited_by_count",
  "authorships",
  "primary_location",
  "open_access",
  "type",
  "referenced_works",
  "language",
  "abstract_inverted_index",
].join(",");

interface OpenAlexWork {
  id?: unknown;
  doi?: unknown;
  title?: unknown;
  publication_year?: unknown;
  publication_date?: unknown;
  cited_by_count?: unknown;
  authorships?: Array<{
    author?: {
      display_name?: unknown;
    };
  }>;
  primary_location?: {
    source?: {
      display_name?: unknown;
    };
  };
  open_access?: {
    is_oa?: unknown;
    oa_url?: unknown;
  };
  type?: unknown;
  referenced_works?: unknown[];
  language?: unknown;
  abstract_inverted_index?: Record<string, number[]>;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function requireOpenAlexString(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`openalex ${label} cannot be empty.`);
  return text;
}

export function requireOpenAlexLimit(value: unknown, fallback = 20): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    throw new Error(
      `openalex limit must be an integer in [1, 200]. Got: ${String(value)}`,
    );
  }
  return n;
}

export function bareOpenAlexId(value: unknown): string {
  return stringField(value)
    .trim()
    .replace(/^https?:\/\/(?:api\.)?openalex\.org\//i, "")
    .replace(/^works\//i, "");
}

export function bareDoi(value: unknown): string {
  return stringField(value)
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
}

export function requireOpenAlexWorkRef(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("openalex work id is required.");
  const openAlexUrl = raw.match(
    /^https?:\/\/(?:api\.)?openalex\.org\/(?:works\/)?([A-Za-z]\d+)/i,
  );
  if (openAlexUrl) {
    const id = openAlexUrl[1].toUpperCase();
    if (!id.startsWith("W"))
      throw new Error(`openalex id must be a Work id, got ${id}.`);
    return id;
  }
  const upper = raw.toUpperCase();
  if (WORK_ID_RE.test(upper)) return upper;
  if (/^doi:/i.test(raw)) {
    const doi = raw.replace(/^doi:/i, "").trim();
    if (DOI_RE.test(doi)) return `doi:${doi}`;
  }
  const doiUrl = raw.match(/^https?:\/\/(?:dx\.)?doi\.org\/(.+)$/i);
  if (doiUrl && DOI_RE.test(doiUrl[1])) return `doi:${doiUrl[1]}`;
  if (DOI_RE.test(raw)) return `doi:${raw}`;
  throw new Error(`openalex work id "${raw}" is not recognised.`);
}

export function reconstructOpenAlexAbstract(index: unknown): string {
  if (!index || typeof index !== "object") return "";
  const positions: string[] = [];
  for (const [token, values] of Object.entries(
    index as Record<string, unknown>,
  )) {
    if (!Array.isArray(values)) continue;
    for (const pos of values) {
      if (Number.isInteger(pos) && pos >= 0 && pos < 100_000) {
        positions[pos] = token;
      }
    }
  }
  return positions.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function appendMailto(url: string): string {
  const mailto = process.env.OPENALEX_MAILTO?.trim();
  if (!mailto) return url;
  return `${url}${url.includes("?") ? "&" : "?"}mailto=${encodeURIComponent(mailto)}`;
}

function firstAuthor(work: OpenAlexWork): string {
  return Array.isArray(work.authorships) && work.authorships.length > 0
    ? stringField(work.authorships[0]?.author?.display_name).trim()
    : "";
}

function authors(work: OpenAlexWork): string {
  return Array.isArray(work.authorships)
    ? work.authorships
        .map((item) => stringField(item.author?.display_name).trim())
        .filter(Boolean)
        .join(", ")
    : "";
}

function venue(work: OpenAlexWork): string {
  return stringField(work.primary_location?.source?.display_name).trim();
}

export function mapOpenAlexSearchRows(
  works: OpenAlexWork[],
  limit: number,
): Array<Record<string, unknown>> {
  return works.slice(0, limit).map((work, index) => {
    const id = bareOpenAlexId(work.id);
    return {
      rank: index + 1,
      id,
      title: stringField(work.title).trim(),
      year: numberField(work.publication_year),
      citations: numberField(work.cited_by_count),
      firstAuthor: firstAuthor(work),
      venue: venue(work),
      openAccess: Boolean(work.open_access?.is_oa),
      type: stringField(work.type).trim(),
      doi: bareDoi(work.doi),
      url: id ? `https://openalex.org/${id}` : "",
    };
  });
}

export function mapOpenAlexWorkRow(
  work: OpenAlexWork,
): Record<string, unknown> {
  const id = bareOpenAlexId(work.id);
  if (!id) throw new Error("OpenAlex returned no work record.");
  return {
    id,
    title: stringField(work.title).trim(),
    type: stringField(work.type).trim(),
    year: numberField(work.publication_year),
    date: stringField(work.publication_date).trim(),
    language: stringField(work.language).trim(),
    authors: authors(work),
    venue: venue(work),
    citations: numberField(work.cited_by_count),
    openAccess: Boolean(work.open_access?.is_oa),
    openAccessUrl: stringField(work.open_access?.oa_url).trim(),
    referencedCount: Array.isArray(work.referenced_works)
      ? work.referenced_works.length
      : null,
    doi: bareDoi(work.doi),
    abstract: reconstructOpenAlexAbstract(work.abstract_inverted_index),
    url: `https://openalex.org/${id}`,
  };
}

async function fetchOpenAlex(url: string, label: string): Promise<unknown> {
  const response = await fetch(appendMailto(url), {
    headers: {
      "User-Agent": "unicli (https://github.com/olo-dot-io/Uni-CLI)",
      Accept: "application/json",
    },
  });
  if (response.status === 404) throw new Error(`${label} returned no result.`);
  if (response.status === 429) throw new Error(`${label} returned HTTP 429.`);
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}.`);
  return response.json();
}

cli({
  site: "openalex",
  name: "search",
  description: "Search OpenAlex Works by keyword",
  domain: "api.openalex.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "Search text",
    },
    { name: "limit", type: "int", default: 20, description: "Max works" },
  ],
  columns: [
    "rank",
    "id",
    "title",
    "year",
    "citations",
    "firstAuthor",
    "venue",
    "openAccess",
    "type",
    "doi",
    "url",
  ],
  func: async (_page, kwargs) => {
    const query = requireOpenAlexString(kwargs.query, "query");
    const limit = requireOpenAlexLimit(kwargs.limit);
    const body = (await fetchOpenAlex(
      `${OPENALEX_BASE}/works?search=${encodeURIComponent(query)}&per-page=${limit}&select=${SEARCH_SELECT}`,
      "openalex search",
    )) as { results?: OpenAlexWork[] };
    const rows = mapOpenAlexSearchRows(
      Array.isArray(body.results) ? body.results : [],
      limit,
    );
    if (rows.length === 0)
      throw new Error(`No OpenAlex works matched "${query}".`);
    return rows;
  },
});

cli({
  site: "openalex",
  name: "work",
  description: "Fetch a single OpenAlex Work",
  domain: "api.openalex.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "id",
      type: "str",
      required: true,
      positional: true,
      description: "OpenAlex Work id or DOI",
    },
  ],
  columns: [
    "id",
    "title",
    "type",
    "year",
    "date",
    "language",
    "authors",
    "venue",
    "citations",
    "openAccess",
    "openAccessUrl",
    "referencedCount",
    "doi",
    "abstract",
    "url",
  ],
  func: async (_page, kwargs) => {
    const ref = requireOpenAlexWorkRef(kwargs.id);
    const work = (await fetchOpenAlex(
      `${OPENALEX_BASE}/works/${encodeURIComponent(ref)}?select=${WORK_SELECT}`,
      "openalex work",
    )) as OpenAlexWork;
    return [mapOpenAlexWorkRow(work)];
  },
});
