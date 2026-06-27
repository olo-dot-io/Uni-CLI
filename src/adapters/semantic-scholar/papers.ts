/**
 * @owner       src::adapters::semantic-scholar::papers
 * @does        Registers Semantic Scholar Graph API paper search, detail, citations, references, and source PDF read commands.
 * @needs       api.semanticscholar.org Graph v1, optional SEMANTIC_SCHOLAR_API_KEY, src/adapters/scholar-artifacts/pdf-read.ts, pdftotext
 * @feeds       src/commands/scholar.ts via scholar.* capability tags
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

const API = "https://api.semanticscholar.org/graph/v1";
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
  if (!raw) throw new Error("semantic-scholar paper reference is required.");
  const doi = bareDoi(raw);
  if (/^10\.\S+\/\S+/.test(doi)) return `DOI:${doi}`;
  if (
    /^(?:arxiv:|https?:\/\/arxiv\.org\/(?:abs|pdf)\/|\d{4}\.\d{4,5})/i.test(raw)
  ) {
    return `ARXIV:${bareArxiv(raw)}`;
  }
  if (/^[a-f0-9]{40}$/i.test(raw)) return raw;
  throw new Error(
    `semantic-scholar paper reference "${raw}" is not recognised.`,
  );
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

async function fetchS2(path: string, label: string): Promise<unknown> {
  const response = await fetch(`${API}${path}`, { headers: headers() });
  if (response.status === 404) throw new Error(`${label} returned no result.`);
  if (response.status === 429) {
    throw new Error(
      `${label} returned HTTP 429; set SEMANTIC_SCHOLAR_API_KEY or retry later.`,
    );
  }
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}.`);
  const json = (await response.json()) as {
    error?: unknown;
    message?: unknown;
  };
  if (json.error || json.message) {
    throw new Error(
      `${label} returned API error: ${String(json.error ?? json.message)}.`,
    );
  }
  return json;
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

cli({
  site: "semantic-scholar",
  name: "search",
  description: "Search Semantic Scholar papers",
  domain: "api.semanticscholar.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
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
  capabilities: ["http.fetch", "scholar.search"],
  func: async (_page, kwargs) => {
    const query = String(kwargs.query ?? "").trim();
    if (!query)
      throw new Error("semantic-scholar search query cannot be empty.");
    const limit = Math.min(Math.max(Number(kwargs.limit ?? 20), 1), 100);
    const body = (await fetchS2(
      `/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=${encodeURIComponent(FIELDS)}`,
      "semantic-scholar search",
    )) as { data?: S2Paper[] };
    const out = rows(body.data);
    if (out.length === 0)
      throw new Error(`No Semantic Scholar papers matched "${query}".`);
    return out;
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
      { name: "limit", type: "int", default: 20 },
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
      const limit = Math.min(Math.max(Number(kwargs.limit ?? 20), 1), 100);
      const body = (await fetchS2(
        `/paper/${encodeURIComponent(ref)}/${path}?limit=${limit}&fields=${encodeURIComponent(FIELDS)}`,
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
