/**
 * @owner       src::adapters::semantic-scholar::papers
 * @does        Registers Semantic Scholar Graph and Recommendations API paper search, detail, graph, recommendation, and source PDF read commands.
 * @needs       api.semanticscholar.org Graph/Recommendations v1, optional SEMANTIC_SCHOLAR_API_KEY, src/adapters/scholar-artifacts/pdf-read.ts, pdftotext
 * @feeds       src/commands/scholar.ts via scholar.* capability tags and AI paper intelligence via ai.* tags
 * @breaks      Graph API rate limits, response-shape drift, missing OA PDF URLs, or pdftotext failures surface as explicit adapter errors; no cached fallback is used.
 * @invariants  Paper references are normalized to Semantic Scholar's accepted DOI:/ARXIV:/paperId formats; read requires openAccessPdf.url before text is claimed.
 * @side-effects HTTPS egress to api.semanticscholar.org and source PDF hosts; read writes one PDF and executes pdftotext.
 * @perf        O(limit) JSON mapping per command; O(PDF bytes + extracted page range) for read
 * @concurrency safe
 * @test        tests/unit/adapters/scholar-sources.test.ts
 * @stability   experimental
 * @since       2026-05-19
 */

import { cli, Strategy } from "../../registry.js";
import type { ScholarlyWorkRecord } from "../../types/scholarly.js";
import { readScholarPdf } from "../scholar-artifacts/pdf-read.js";

const GRAPH_API = "https://api.semanticscholar.org/graph/v1";
const RECOMMENDATIONS_API =
  "https://api.semanticscholar.org/recommendations/v1";
const REQUEST_TIMEOUT_MS = 15_000;
const FIELDS = [
  "paperId",
  "title",
  "abstract",
  "year",
  "authors",
  "citationCount",
  "referenceCount",
  "venue",
  "publicationVenue",
  "url",
  "openAccessPdf",
  "externalIds",
].join(",");

interface S2Paper {
  paperId?: unknown;
  title?: unknown;
  abstract?: unknown;
  year?: unknown;
  authors?: Array<{ name?: unknown }>;
  citationCount?: unknown;
  referenceCount?: unknown;
  venue?: unknown;
  url?: unknown;
  openAccessPdf?: { url?: unknown };
  externalIds?: Record<string, unknown>;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function bareDoi(value: unknown): string {
  return str(value)
    .replace(/^doi:/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
}

function bareArxiv(value: unknown): string {
  return str(value)
    .replace(/^arxiv:/i, "")
    .replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//i, "")
    .replace(/\.pdf$/i, "")
    .replace(/v\d+$/i, "");
}

export function requireSemanticScholarPaperRef(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw semanticScholarError(
      "invalid_input",
      "semantic-scholar paper reference is required.",
      "Provide a Semantic Scholar paperId, DOI, arXiv id, or supported prefixed id.",
    );
  }
  const semanticScholarUrl = raw.match(
    /^https?:\/\/(?:www\.)?semanticscholar\.org\/paper\/(?:[^/]+\/)?([a-f0-9]{40})(?:[/?#]|$)/i,
  );
  if (semanticScholarUrl?.[1]) return semanticScholarUrl[1].toLowerCase();
  const doi = bareDoi(raw);
  if (/^10\.\S+\/\S+/.test(doi)) return `DOI:${doi}`;
  if (
    /^(?:arxiv:|https?:\/\/arxiv\.org\/(?:abs|pdf)\/|\d{4}\.\d{4,5})/i.test(raw)
  ) {
    return `ARXIV:${bareArxiv(raw)}`;
  }
  if (/^[a-f0-9]{40}$/i.test(raw)) return raw.toLowerCase();
  if (/^(?:MAG|ACL|PMID|PMCID|URL|CorpusId|DBLP):\S+$/i.test(raw)) {
    return raw;
  }
  throw semanticScholarError(
    "invalid_input",
    `semantic-scholar paper reference "${raw}" is not recognised.`,
    "Use a Semantic Scholar paperId, DOI, arXiv id, Semantic Scholar URL, or supported prefixed id.",
  );
}

type SemanticScholarErrorCode =
  | "invalid_input"
  | "empty_result"
  | "upstream_error"
  | "rate_limited";

function semanticScholarError(
  code: SemanticScholarErrorCode,
  message: string,
  suggestion: string,
): Error {
  return Object.assign(new Error(message), {
    code,
    suggestion,
    retryable: code === "upstream_error" || code === "rate_limited",
    alternatives: [] as string[],
  });
}

export function requireSemanticScholarBoundedInt(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const number =
    value === undefined || value === null ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw semanticScholarError(
      "invalid_input",
      `semantic-scholar ${label} must be an integer in [${String(minimum)}, ${String(maximum)}].`,
      `Choose a bounded ${label} value and retry.`,
    );
  }
  return number;
}

function headers(): Record<string, string> {
  const out: Record<string, string> = {
    Accept: "application/json",
    "User-Agent":
      "unicli-semantic-scholar/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
  };
  const key = process.env.SEMANTIC_SCHOLAR_API_KEY?.trim();
  if (key) out["x-api-key"] = key;
  return out;
}

async function fetchS2Url(url: string, label: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: headers(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 404) {
    throw semanticScholarError(
      "empty_result",
      `${label} returned no result.`,
      "Verify the paper reference or search Semantic Scholar first.",
    );
  }
  if (response.status === 429) {
    throw semanticScholarError(
      "rate_limited",
      `${label} returned HTTP 429; set SEMANTIC_SCHOLAR_API_KEY or retry later.`,
      "Set SEMANTIC_SCHOLAR_API_KEY or retry after the provider rate-limit window.",
    );
  }
  if (!response.ok) {
    throw semanticScholarError(
      "upstream_error",
      `${label} returned HTTP ${response.status}.`,
      "Retry after the Semantic Scholar API is reachable and healthy.",
    );
  }
  const json = (await response.json()) as {
    error?: unknown;
    message?: unknown;
  };
  if (json.error || json.message) {
    throw semanticScholarError(
      "upstream_error",
      `${label} returned API error: ${String(json.error ?? json.message)}.`,
      "Inspect the provider error, correct the request when needed, and retry.",
    );
  }
  return json;
}

async function fetchS2(path: string, label: string): Promise<unknown> {
  return fetchS2Url(`${GRAPH_API}${path}`, label);
}

export function mapSemanticScholarPaper(
  paper: S2Paper,
  source: string,
): ScholarlyWorkRecord {
  const id = str(paper.paperId);
  if (!id)
    throw new Error("Semantic Scholar returned a paper without paperId.");
  const doi = bareDoi(paper.externalIds?.DOI);
  const arxiv = bareArxiv(paper.externalIds?.ArXiv);
  return {
    id,
    title: str(paper.title),
    abstract: str(paper.abstract) || undefined,
    authors: Array.isArray(paper.authors)
      ? paper.authors.map((author) => str(author.name)).filter(Boolean)
      : undefined,
    year: num(paper.year),
    venue: str(paper.venue) || undefined,
    doi: doi || undefined,
    arxiv_id: arxiv || undefined,
    semantic_scholar_id: id,
    cited_by_count: num(paper.citationCount),
    references_count: num(paper.referenceCount),
    pdf_url: str(paper.openAccessPdf?.url) || undefined,
    source_adapter: source,
    source_url: str(paper.url) || `https://www.semanticscholar.org/paper/${id}`,
    retrieved_at: new Date().toISOString(),
  };
}

async function readSemanticScholarPaperPdf(
  row: ScholarlyWorkRecord,
  kwargs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const pdfUrl = str(row.pdf_url);
  if (!pdfUrl) {
    throw new Error(`Semantic Scholar paper ${row.id} has no source PDF URL.`);
  }
  return readScholarPdf(
    {
      ...kwargs,
      id: row.id,
      title: row.title,
      source_adapter: row.source_adapter,
      source_url: row.source_url,
      pdf_url: pdfUrl,
    },
    {
      site: "semantic-scholar",
      command: "read",
      defaultOutput: "./semantic-scholar-downloads",
      userAgent:
        "unicli-semantic-scholar/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
    },
  );
}

function rows(
  papers: unknown,
  source = "semantic-scholar",
): ScholarlyWorkRecord[] {
  const list = Array.isArray(papers) ? papers : [];
  return list.map((paper) => mapSemanticScholarPaper(paper as S2Paper, source));
}

export function mapSemanticScholarRecommendations(
  payload: unknown,
  limit: number,
): Array<ScholarlyWorkRecord & { rank: number }> {
  if (payload === null || typeof payload !== "object") {
    throw semanticScholarError(
      "upstream_error",
      "semantic-scholar recommendations returned a non-object payload.",
      "Retry after the Recommendations API response stabilizes.",
    );
  }
  const recommended = (payload as { recommendedPapers?: unknown })
    .recommendedPapers;
  if (!Array.isArray(recommended)) {
    throw semanticScholarError(
      "upstream_error",
      "semantic-scholar recommendations omitted recommendedPapers.",
      "Retry after the Recommendations API response stabilizes.",
    );
  }
  if (recommended.length === 0) {
    throw semanticScholarError(
      "empty_result",
      "Semantic Scholar returned no recommendations for this paper.",
      "Use a paper with a populated Semantic Scholar citation graph.",
    );
  }
  return recommended.slice(0, limit).map((paper, index) => ({
    rank: index + 1,
    ...mapSemanticScholarPaper(
      paper as S2Paper,
      "semantic-scholar-recommendations",
    ),
  }));
}

cli({
  site: "semantic-scholar",
  name: "search",
  description: "Search Semantic Scholar papers",
  domain: "api.semanticscholar.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      minLength: 1,
    },
    { name: "limit", type: "int", default: 20, minimum: 1, maximum: 100 },
  ],
  columns: [
    "id",
    "title",
    "authors",
    "year",
    "venue",
    "doi",
    "pdf_url",
    "source_url",
  ],
  operation_effect: "read",
  execution_operator: "structured-api",
  retrieval: {
    operation: "discover",
    result_kind: "paper",
    source_class: "hosted-artifact",
    arguments: { query: "query", limit: "limit" },
  },
  capabilities: ["http.fetch", "scholar.search"],
  func: async (_page, kwargs) => {
    const query = String(kwargs.query ?? "").trim();
    if (!query)
      throw new Error("semantic-scholar search query cannot be empty.");
    const limit = requireSemanticScholarBoundedInt(
      kwargs.limit,
      20,
      1,
      100,
      "search limit",
    );
    const body = (await fetchS2(
      `/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=${encodeURIComponent(FIELDS)}`,
      "semantic-scholar search",
    )) as { data?: S2Paper[] };
    return rows(body.data);
  },
});

cli({
  site: "semantic-scholar",
  name: "paper",
  description: "Fetch one Semantic Scholar paper by paperId, DOI, or arXiv id",
  domain: "api.semanticscholar.org",
  strategy: Strategy.PUBLIC,
  args: [{ name: "id", type: "str", required: true, positional: true }],
  columns: [
    "id",
    "title",
    "authors",
    "year",
    "venue",
    "doi",
    "pdf_url",
    "source_url",
  ],
  capabilities: ["http.fetch", "scholar.get", "scholar.pdf"],
  func: async (_page, kwargs) => {
    const ref = requireSemanticScholarPaperRef(
      kwargs.id ?? kwargs.ref ?? kwargs.doi ?? kwargs.arxiv_id,
    );
    const paper = (await fetchS2(
      `/paper/${encodeURIComponent(ref)}?fields=${encodeURIComponent(FIELDS)}`,
      `semantic-scholar paper ${ref}`,
    )) as S2Paper;
    return [mapSemanticScholarPaper(paper, "semantic-scholar")];
  },
});

cli({
  site: "semantic-scholar",
  name: "read",
  description:
    "Download a Semantic Scholar open-access paper PDF and extract text",
  domain: "api.semanticscholar.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "id", type: "str", required: true, positional: true },
    {
      name: "output",
      type: "str",
      default: "./semantic-scholar-downloads",
      description: "Output directory for the downloaded PDF",
      "x-unicli-kind": "path",
    },
    { name: "filename", type: "str", description: "Output PDF filename" },
    { name: "first-page", type: "int", default: 1, description: "First page" },
    { name: "last-page", type: "int", default: 20, description: "Last page" },
    {
      name: "max-chars",
      type: "int",
      default: 40000,
      description: "Maximum extracted text characters",
    },
  ],
  columns: [
    "id",
    "title",
    "source_adapter",
    "source_url",
    "pdf_url",
    "path",
    "text_source",
    "text",
    "text_chars",
    "text_truncated",
  ],
  capabilities: [
    "http.fetch",
    "http.download",
    "subprocess.exec",
    "scholar.fulltext",
    "scholar.pdf",
  ],
  executables: ["pdftotext"],
  minimum_capability: "subprocess.exec",
  func: async (_page, kwargs) => {
    const ref = requireSemanticScholarPaperRef(
      kwargs.id ?? kwargs.ref ?? kwargs.doi ?? kwargs.arxiv_id,
    );
    const paper = (await fetchS2(
      `/paper/${encodeURIComponent(ref)}?fields=${encodeURIComponent(FIELDS)}`,
      `semantic-scholar paper ${ref}`,
    )) as S2Paper;
    return [
      await readSemanticScholarPaperPdf(
        mapSemanticScholarPaper(paper, "semantic-scholar"),
        kwargs,
      ),
    ];
  },
});

for (const [name, path, cap] of [
  ["citations", "citations", "scholar.citations"],
  ["references", "references", "scholar.references"],
] as const) {
  cli({
    site: "semantic-scholar",
    name,
    description: `List Semantic Scholar paper ${name}`,
    domain: "api.semanticscholar.org",
    strategy: Strategy.PUBLIC,
    args: [
      { name: "id", type: "str", required: true, positional: true },
      {
        name: "limit",
        type: "int",
        default: 20,
        minimum: 1,
        maximum: 1000,
      },
      {
        name: "offset",
        type: "int",
        default: 0,
        minimum: 0,
      },
    ],
    columns: [
      "id",
      "title",
      "authors",
      "year",
      "venue",
      "doi",
      "pdf_url",
      "source_url",
    ],
    capabilities: ["http.fetch", cap],
    func: async (_page, kwargs) => {
      const ref = requireSemanticScholarPaperRef(kwargs.id ?? kwargs.ref);
      const limit = requireSemanticScholarBoundedInt(
        kwargs.limit,
        20,
        1,
        1000,
        `${name} limit`,
      );
      const offset = requireSemanticScholarBoundedInt(
        kwargs.offset,
        0,
        0,
        Number.MAX_SAFE_INTEGER,
        `${name} offset`,
      );
      const body = (await fetchS2(
        `/paper/${encodeURIComponent(ref)}/${path}?limit=${limit}&offset=${offset}&fields=${encodeURIComponent(FIELDS)}`,
        `semantic-scholar ${name} ${ref}`,
      )) as { data?: Array<{ citingPaper?: S2Paper; citedPaper?: S2Paper }> };
      const papers = (body.data ?? []).map((item) =>
        name === "citations" ? item.citingPaper : item.citedPaper,
      );
      const out = rows(papers);
      if (out.length === 0)
        throw new Error(`No Semantic Scholar ${name} found for ${ref}.`);
      return out;
    },
  });
}

cli({
  site: "semantic-scholar",
  name: "recommendations",
  description:
    "Get Semantic Scholar AI-curated related papers for a paperId, DOI, or arXiv id",
  domain: "api.semanticscholar.org",
  strategy: Strategy.PUBLIC,
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "list",
  minimum_capability: "http.fetch",
  args: [
    { name: "id", type: "str", required: true, positional: true, minLength: 1 },
    {
      name: "limit",
      type: "int",
      default: 10,
      minimum: 1,
      maximum: 500,
    },
    {
      name: "pool",
      type: "str",
      default: "recent",
      choices: ["recent", "all-cs"],
      description: "Recommendation candidate pool",
    },
  ],
  columns: [
    "rank",
    "id",
    "title",
    "authors",
    "year",
    "venue",
    "doi",
    "pdf_url",
    "source_url",
  ],
  capabilities: ["http.fetch", "scholar.recommendations"],
  func: async (_page, kwargs) => {
    const ref = requireSemanticScholarPaperRef(kwargs.id ?? kwargs.ref);
    const limit = requireSemanticScholarBoundedInt(
      kwargs.limit,
      10,
      1,
      500,
      "recommendations limit",
    );
    const pool = String(kwargs.pool ?? "recent");
    if (pool !== "recent" && pool !== "all-cs") {
      throw semanticScholarError(
        "invalid_input",
        'semantic-scholar recommendations pool must be "recent" or "all-cs".',
        "Choose one of the declared recommendation pools.",
      );
    }
    const query = new URLSearchParams({
      fields: FIELDS,
      limit: String(limit),
      from: pool,
    });
    return mapSemanticScholarRecommendations(
      await fetchS2Url(
        `${RECOMMENDATIONS_API}/papers/forpaper/${encodeURIComponent(ref)}?${query.toString()}`,
        `semantic-scholar recommendations ${ref}`,
      ),
      limit,
    );
  },
});
