/**
 * @owner       src::adapters::ieee-xplore::articles
 * @does        Registers IEEE Xplore Metadata API search, article lookup, and publication browse commands.
 * @needs       IEEE_XPLORE_API_KEY or IEEE_API_KEY, ieeexploreapi.ieee.org
 * @feeds       src/commands/scholar.ts via scholar.search, scholar.get, scholar.pdf, and scholar.venue
 * @breaks      Missing API credentials, quota exhaustion, or response drift surfaces as an actionable structured error.
 * @invariants  API keys never enter result rows; paging remains within IEEE's documented bounds; article provenance points to IEEE Xplore.
 * @side-effects HTTPS egress to ieeexploreapi.ieee.org
 * @perf        O(max_records) JSON mapping, one request per invocation
 * @concurrency safe
 * @test        tests/unit/adapters/scholar-publishers.test.ts
 * @stability   experimental
 * @since       2026-08-09
 */

import { cli, Strategy } from "../../registry.js";
import type { ScholarlyWorkRecord } from "../../types/scholarly.js";

const API = "https://ieeexploreapi.ieee.org/api/v1/search/articles";

interface IeeeAuthor {
  full_name?: unknown;
  author_order?: unknown;
  authorUrl?: unknown;
  id?: unknown;
  affiliation?: unknown;
}

export interface IeeeXploreArticle {
  article_number?: unknown;
  title?: unknown;
  authors?: { authors?: IeeeAuthor[] };
  publication_title?: unknown;
  publication_year?: unknown;
  publication_date?: unknown;
  content_type?: unknown;
  abstract?: unknown;
  doi?: unknown;
  citing_paper_count?: unknown;
  citing_patent_count?: unknown;
  abstract_url?: unknown;
  pdf_url?: unknown;
  html_url?: unknown;
  access_type?: unknown;
  conference_location?: unknown;
  conference_dates?: unknown;
  isbn?: unknown;
  issn?: unknown;
  publisher?: unknown;
  index_terms?: unknown;
}

interface IeeeXploreEnvelope {
  articles?: IeeeXploreArticle[];
  total_records?: unknown;
}

interface ActionableConfigError extends Error {
  code: "config_error";
  suggestion: string;
  alternatives: string[];
  retryable: false;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function integer(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function requiredText(value: unknown, label: string): string {
  const result = text(value);
  if (!result) throw new Error(`ieee-xplore ${label} cannot be empty.`);
  return result;
}

export function boundedIeeeInt(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const result =
    value === undefined || value === null || value === ""
      ? fallback
      : Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new Error(
      `ieee-xplore ${label} must be an integer in [${minimum}, ${maximum}].`,
    );
  }
  return result;
}

export function requireIeeeXploreApiKey(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const key =
    environment.IEEE_XPLORE_API_KEY?.trim() ||
    environment.IEEE_API_KEY?.trim() ||
    "";
  if (key) return key;

  const error = new Error(
    "IEEE Xplore Metadata API access requires IEEE_XPLORE_API_KEY.",
  ) as ActionableConfigError;
  error.name = "IeeeXploreConfigError";
  error.code = "config_error";
  error.suggestion =
    "Register an IEEE Xplore API key, export IEEE_XPLORE_API_KEY, then retry. Use `unicli ieee search` for keyless DOI metadata.";
  error.alternatives = ["unicli ieee search", "unicli crossref search"];
  error.retryable = false;
  throw error;
}

export function buildIeeeXploreParams(
  apiKey: string,
  input: Record<string, unknown>,
): URLSearchParams {
  const params = new URLSearchParams({
    apikey: apiKey,
    format: "json",
    max_records: String(
      boundedIeeeInt(input.limit ?? input.max_records, 25, 1, 200, "limit"),
    ),
    start_record: String(
      boundedIeeeInt(input.start ?? input.start_record, 1, 1, 100_000, "start"),
    ),
    sort_order: text(input.sort_order) || "desc",
    sort_field: text(input.sort_field) || "publication_year",
  });

  const fields = [
    "querytext",
    "article_title",
    "article_number",
    "doi",
    "publication_title",
    "publication_year",
    "author",
    "affiliation",
    "publisher",
    "content_type",
  ] as const;
  for (const field of fields) {
    const value =
      typeof input[field] === "number"
        ? String(input[field])
        : text(input[field]);
    if (value) params.set(field, value);
  }
  return params;
}

export function mapIeeeXploreArticle(
  article: IeeeXploreArticle,
): ScholarlyWorkRecord {
  const articleNumber = text(article.article_number);
  const doi = text(article.doi).replace(/^https?:\/\/doi\.org\//i, "");
  const title = text(article.title);
  const landingUrl =
    text(article.html_url) ||
    text(article.abstract_url) ||
    (articleNumber
      ? `https://ieeexplore.ieee.org/document/${articleNumber}`
      : doi
        ? `https://doi.org/${doi}`
        : "");
  const authorRows = Array.isArray(article.authors?.authors)
    ? article.authors.authors
    : [];
  const authors = authorRows
    .map((author) => text(author.full_name))
    .filter(Boolean);

  return {
    id: articleNumber || doi || title,
    title,
    authors: authors.length > 0 ? authors : undefined,
    year: integer(article.publication_year),
    date: text(article.publication_date) || undefined,
    venue: text(article.publication_title) || undefined,
    type: text(article.content_type) || undefined,
    abstract: text(article.abstract) || undefined,
    doi: doi || undefined,
    cited_by_count: integer(article.citing_paper_count),
    pdf_url: text(article.pdf_url) || undefined,
    landing_url: landingUrl || undefined,
    source_adapter: "ieee-xplore",
    source_url: landingUrl || API,
    retrieved_at: new Date().toISOString(),
    raw: {
      article_number: articleNumber || undefined,
      access_type: text(article.access_type) || undefined,
      citing_patent_count: integer(article.citing_patent_count),
      conference_location: text(article.conference_location) || undefined,
      conference_dates: text(article.conference_dates) || undefined,
      isbn: text(article.isbn) || undefined,
      issn: text(article.issn) || undefined,
      publisher: text(article.publisher) || undefined,
      index_terms: article.index_terms,
      authors: authorRows,
    },
  };
}

async function requestIeeeXplore(
  input: Record<string, unknown>,
): Promise<ScholarlyWorkRecord[]> {
  const key = requireIeeeXploreApiKey();
  const url = `${API}?${buildIeeeXploreParams(key, input).toString()}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (response.status === 401 || response.status === 403) {
    const error = new Error(
      `IEEE Xplore rejected the configured API key with HTTP ${response.status}.`,
    ) as ActionableConfigError;
    error.code = "config_error";
    error.suggestion =
      "Check IEEE_XPLORE_API_KEY and the API plan, then retry. Use `unicli ieee search` for keyless DOI metadata.";
    error.alternatives = ["unicli ieee search", "unicli crossref search"];
    error.retryable = false;
    throw error;
  }
  if (response.status === 429) {
    const error = new Error(
      "IEEE Xplore Metadata API returned HTTP 429.",
    ) as Error & {
      code: string;
    };
    error.code = "rate_limited";
    throw error;
  }
  if (!response.ok) {
    throw new Error(
      `IEEE Xplore Metadata API returned HTTP ${response.status}.`,
    );
  }
  const body = (await response.json()) as IeeeXploreEnvelope;
  return (body.articles ?? []).map(mapIeeeXploreArticle);
}

const commonColumns = [
  "id",
  "title",
  "authors",
  "year",
  "venue",
  "type",
  "doi",
  "cited_by_count",
  "pdf_url",
  "source_url",
];

cli({
  site: "ieee-xplore",
  name: "search",
  description: "Search IEEE Xplore article metadata with an IEEE API key",
  domain: "ieeexploreapi.ieee.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "year", type: "int", minimum: 1900, maximum: 2100 },
    { name: "limit", type: "int", default: 25, minimum: 1, maximum: 200 },
    { name: "start", type: "int", default: 1, minimum: 1, maximum: 100000 },
  ],
  columns: commonColumns,
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "search",
  retrieval: {
    operation: "discover",
    result_kind: "paper",
    source_class: "official",
    arguments: { query: "query", limit: "limit" },
  },
  capabilities: ["http.fetch", "scholar.search"],
  func: async (_page, kwargs) => {
    const query = requiredText(kwargs.query, "search query");
    const rows = await requestIeeeXplore({
      querytext: query,
      publication_year: kwargs.year,
      limit: kwargs.limit,
      start: kwargs.start,
    });
    if (rows.length === 0)
      throw new Error(`No IEEE Xplore articles matched "${query}".`);
    return rows;
  },
});

cli({
  site: "ieee-xplore",
  name: "article",
  description: "Fetch one IEEE Xplore article by article number or DOI",
  domain: "ieeexploreapi.ieee.org",
  strategy: Strategy.PUBLIC,
  args: [{ name: "ref", type: "str", required: true, positional: true }],
  columns: commonColumns,
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "get",
  capabilities: ["http.fetch", "scholar.get", "scholar.pdf"],
  func: async (_page, kwargs) => {
    const ref = requiredText(
      kwargs.ref ?? kwargs.id ?? kwargs.doi,
      "reference",
    );
    const isDoi = /^10\.\d{4,9}\//i.test(
      ref.replace(/^https?:\/\/doi\.org\//i, ""),
    );
    const rows = await requestIeeeXplore(
      isDoi
        ? { doi: ref.replace(/^https?:\/\/doi\.org\//i, ""), limit: 1 }
        : { article_number: ref, limit: 1 },
    );
    if (rows.length === 0)
      throw new Error(`IEEE Xplore returned no article for "${ref}".`);
    return rows;
  },
});

cli({
  site: "ieee-xplore",
  name: "venue",
  description: "List IEEE Xplore articles from a publication or conference",
  domain: "ieeexploreapi.ieee.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "venue", type: "str", required: true, positional: true },
    { name: "year", type: "int", minimum: 1900, maximum: 2100 },
    { name: "limit", type: "int", default: 50, minimum: 1, maximum: 200 },
    { name: "start", type: "int", default: 1, minimum: 1, maximum: 100000 },
  ],
  columns: commonColumns,
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "list",
  capabilities: ["http.fetch", "scholar.venue"],
  func: async (_page, kwargs) => {
    const venue = requiredText(kwargs.venue, "venue");
    const rows = await requestIeeeXplore({
      publication_title: venue,
      publication_year: kwargs.year,
      limit: kwargs.limit,
      start: kwargs.start,
    });
    if (rows.length === 0)
      throw new Error(`No IEEE Xplore articles matched venue "${venue}".`);
    return rows;
  },
});
