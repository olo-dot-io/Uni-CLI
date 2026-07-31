/**
 * @owner   src/adapters/arxiv/papers.ts
 * @does    Register agent-facing arXiv natural/structured search, author, recent category, and PDF text-read commands.
 * @needs   export.arxiv.org Atom API, arxiv.org PDF URLs, shared fetch_text/retrieval relevance boundaries, category/id/query validation, conservative XML parsing, pdftotext.
 * @feeds   AI and scholarly search/read workflows, surface coverage ledger, and arXiv category monitoring.
 * @breaks  arXiv query/Atom/PDF shape drift, weak category/id parsing, denied PDF downloads, missing pdftotext, or relevance-blind latest sorting hide paper discovery/read failures.
 * @invariants  Natural multi-term search compiles every meaningful term into an explicit arXiv field clause and filters before limiting; caller-authored arXiv field syntax is preserved; ids are normalized before URL construction; read returns PDF-derived text only and labels `text_source=pdf`.
 * @side-effects HTTPS egress to export.arxiv.org and arxiv.org; read writes PDFs under the requested output directory and executes pdftotext.
 * @perf        O(limit) for Atom discovery; O(PDF bytes + extracted pages) for read.
 * @concurrency safe - per-command local state only
 * @test        src/adapters/arxiv/papers.test.ts, tests/unit/commands/scholar.test.ts
 * @stability   experimental
 * @since       0.225.2
 */

import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { cli, Strategy } from "../../registry.js";
import { httpDownload, sanitizeFilename } from "../../engine/download.js";
import { fetchTextResource } from "../../engine/steps/fetch-text.js";
import {
  analyzeRetrievalQuery,
  scoreRetrievalAlternatives,
  scoreRetrievalCandidate,
  splitRetrievalDisjunction,
} from "../../engine/retrieval-relevance.js";

const ARXIV_BASE = "https://export.arxiv.org/api/query";
const CATEGORY_RE = /^[a-z]+(?:-[a-z]+)*(?:\.[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)?$/;
const execFileAsync = promisify(execFile);

interface ArxivEntry {
  id: string;
  title: string;
  authors: string;
  abstract: string;
  published: string;
  updated: string;
  primary_category: string;
  categories: string;
  comment: string;
  pdf: string;
  url: string;
}

export function requireArxivLimit(
  value: unknown,
  fallback: number,
  max = 50,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new Error(`arxiv limit must be an integer in [1, ${max}].`);
  }
  return n;
}

export function requireArxivAuthor(value: unknown): string {
  const author = String(value ?? "").trim();
  if (!author) throw new Error("arxiv author cannot be empty.");
  return author;
}

export function normalizeArxivId(value: unknown): string {
  const id = String(value ?? "")
    .trim()
    .replace(/^arxiv:/i, "")
    .replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, "")
    .replace(/\.pdf$/i, "");
  if (
    !/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i.test(id)
  ) {
    throw new Error(`Invalid arXiv id "${String(value ?? "")}".`);
  }
  return id;
}

export function requireArxivCategory(value: unknown): string {
  const category = String(value ?? "").trim();
  if (!CATEGORY_RE.test(category)) {
    throw new Error(`Invalid arXiv category "${String(value)}".`);
  }
  return category;
}

export function decodeArxivEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'");
}

function extractFirst(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return match ? match[1].trim() : "";
}

function extractAll(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) out.push(match[1].trim());
  return out;
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const match = xml.match(new RegExp(`<${tag}\\b[^>]*?\\b${attr}="([^"]*)"`));
  return match ? match[1] : "";
}

function extractAllAttr(xml: string, tag: string, attr: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}\\b[^>]*?\\b${attr}="([^"]*)"`, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) out.push(match[1]);
  return out;
}

function findLinkHref(xml: string, rel: string): string {
  const re = /<link\b([^>]*)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const attrs = match[1];
    if (!new RegExp(`\\brel="${rel}"`).test(attrs)) continue;
    const href = attrs.match(/\bhref="([^"]*)"/);
    if (href) return href[1];
  }
  return "";
}

export function parseArxivEntries(xml: string): ArxivEntry[] {
  const out: ArxivEntry[] = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const entry = match[1];
    const rawId = extractFirst(entry, "id");
    const id = rawId
      .replace(/^https?:\/\/arxiv\.org\/abs\//, "")
      .replace(/v\d+$/, "");
    const title = decodeArxivEntities(
      extractFirst(entry, "title").replace(/\s+/g, " "),
    ).trim();
    out.push({
      id,
      title,
      authors: decodeArxivEntities(extractAll(entry, "name").join(", ")),
      abstract: decodeArxivEntities(
        extractFirst(entry, "summary").replace(/\s+/g, " "),
      ).trim(),
      published: extractFirst(entry, "published").slice(0, 10),
      updated: extractFirst(entry, "updated").slice(0, 10),
      primary_category: extractAttr(entry, "arxiv:primary_category", "term"),
      categories: extractAllAttr(entry, "category", "term").join(", "),
      comment: decodeArxivEntities(
        extractFirst(entry, "arxiv:comment").replace(/\s+/g, " "),
      ).trim(),
      pdf: findLinkHref(entry, "related") || `https://arxiv.org/pdf/${id}`,
      url: `https://arxiv.org/abs/${id}`,
    });
  }
  return out;
}

async function fetchArxiv(
  params: URLSearchParams,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${ARXIV_BASE}?${params.toString()}`;
  const resource = await fetchTextResource(
    url,
    { url, retry: 1 },
    {
      "User-Agent": "unicli-arxiv/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
      Accept: "application/atom+xml, application/xml, text/xml",
    },
    -1,
    { signal },
  );
  return resource.text;
}

function compactRows(entries: ArxivEntry[]): Array<Record<string, unknown>> {
  return entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    authors: entry.authors,
    published: entry.published,
    primary_category: entry.primary_category,
    url: entry.url,
  }));
}

function searchRows(entries: ArxivEntry[]): Array<Record<string, unknown>> {
  return entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    authors: entry.authors,
    published: entry.published,
    updated: entry.updated,
    summary: entry.abstract,
    primary_category: entry.primary_category,
    url: entry.url,
  }));
}

function requireArxivSearchQuery(value: unknown): string {
  const query = String(value ?? "").trim();
  if (!query) throw new Error("arxiv search query cannot be empty.");
  return query;
}

function requireArxivSort(value: unknown): "relevance" | "submittedDate" {
  const sort = String(value ?? "relevance");
  if (sort !== "relevance" && sort !== "submittedDate") {
    throw new Error("arxiv sort must be relevance or submittedDate.");
  }
  return sort;
}

function hasArxivFieldSyntax(query: string): boolean {
  return /(?:^|[\s(])(?:all|ti|au|abs|co|jr|cat|rn|id):/i.test(query);
}

function arxivFieldValue(value: string): string {
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return /^[\p{L}\p{N}_+.#/-]+$/u.test(value) ? escaped : `"${escaped}"`;
}

export function compileArxivSearchQuery(value: unknown): string {
  const query = requireArxivSearchQuery(value);
  if (hasArxivFieldSyntax(query)) return query;
  if (/(?:^|\s)(?:NOT|ANDNOT)(?:\s|$)/i.test(query)) {
    throw new Error(
      "Natural arXiv exclusion requires explicit field syntax such as all:term ANDNOT all:excluded.",
    );
  }

  const alternatives = splitRetrievalDisjunction(query);
  const compiled = alternatives.map((alternative) => {
    const phrases = [...alternative.matchAll(/"([^"\n]+)"/g)]
      .map((match) => match[1].trim())
      .filter(Boolean);
    const remaining = alternative.replaceAll(/"[^"\n]+"/g, " ");
    const terms = analyzeRetrievalQuery(remaining).terms;
    const clauses = [
      ...phrases.map((phrase) => `all:${arxivFieldValue(phrase)}`),
      ...terms.map((term) => `all:${arxivFieldValue(term)}`),
    ];
    return clauses.length > 0
      ? clauses.join(" AND ")
      : `all:${arxivFieldValue(alternative)}`;
  });
  return compiled.length > 1
    ? compiled.map((clause) => `(${clause})`).join(" OR ")
    : compiled[0];
}

export async function searchArxivPapers(
  kwargs: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Array<Record<string, unknown>>> {
  const query = requireArxivSearchQuery(kwargs.query);
  const limit = requireArxivLimit(kwargs.limit, 10);
  const sort = requireArxivSort(kwargs.sort);
  const candidateLimit = Math.min(Math.max(limit * 3, 20), 50);
  const params = new URLSearchParams({
    search_query: compileArxivSearchQuery(query),
    max_results: String(candidateLimit),
    sortBy: sort,
    sortOrder: "descending",
  });
  const entries = parseArxivEntries(await fetchArxiv(params, signal));
  if (hasArxivFieldSyntax(query)) return searchRows(entries.slice(0, limit));

  const alternatives = splitRetrievalDisjunction(query);
  const analyses = alternatives.map(analyzeRetrievalQuery);
  const analysis = analyzeRetrievalQuery(query);
  const isDisjunctive = alternatives.length > 1;
  let relevant = entries
    .map((entry, sourceIndex) => ({
      entry,
      sourceIndex,
      relevance: scoreRetrievalAlternatives(
        analyses,
        {
          title: entry.title,
          summary: entry.abstract,
          url: entry.url,
        },
        { requireAllTerms: true },
      ),
    }))
    .filter(({ relevance }) => relevance.qualifies);
  if (
    !isDisjunctive &&
    analysis.phrases.length === 0 &&
    analysis.terms.length > 1
  ) {
    const phraseLayers = [
      [analysis.terms.join(" ")],
      analysis.terms.slice(0, -1).map((term, index) => {
        return `${term} ${analysis.terms[index + 1]}`;
      }),
    ];
    for (const phrases of phraseLayers) {
      const phraseMatches = relevant.filter(({ entry }) =>
        phrases.some(
          (phrase) =>
            scoreRetrievalCandidate(
              { ...analysis, phrases: [phrase] },
              {
                title: entry.title,
                summary: entry.abstract,
                url: entry.url,
              },
              { requireAllTerms: true },
            ).qualifies,
        ),
      );
      if (phraseMatches.length > 0) {
        relevant = phraseMatches;
        break;
      }
    }
  }
  if (sort === "relevance") {
    relevant.sort(
      (left, right) =>
        right.relevance.score - left.relevance.score ||
        left.sourceIndex - right.sourceIndex,
    );
  }
  return searchRows(relevant.slice(0, limit).map(({ entry }) => entry));
}

function arxivPdfUrl(id: string): string {
  return `https://arxiv.org/pdf/${id}`;
}

function arxivAbsUrl(id: string): string {
  return `https://arxiv.org/abs/${id.replace(/v\d+$/i, "")}`;
}

export function arxivArtifactFilename(input: {
  id: string;
  title?: unknown;
}): string {
  const title = String(input.title ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return sanitizeFilename(`${input.id}${title ? `-${title}` : ""}.pdf`);
}

export function requireArxivPageRange(
  firstPage: unknown,
  lastPage: unknown,
): { firstPage: number; lastPage: number } {
  const first = Number(firstPage ?? 1);
  const last = Number(lastPage ?? 20);
  if (!Number.isInteger(first) || first < 1) {
    throw new Error("arxiv first-page must be an integer >= 1.");
  }
  if (!Number.isInteger(last) || last < first) {
    throw new Error("arxiv last-page must be an integer >= first-page.");
  }
  return { firstPage: first, lastPage: last };
}

export function requireArxivMaxChars(
  value: unknown,
  fallback = 40_000,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1_000 || n > 1_000_000) {
    throw new Error(
      `arxiv max-chars must be an integer in [1000, 1000000]. Got: ${String(value)}`,
    );
  }
  return n;
}

function truncateText(
  text: string,
  maxChars: number,
): {
  text: string;
  truncated: boolean;
  originalChars: number;
} {
  if (text.length <= maxChars) {
    return { text, truncated: false, originalChars: text.length };
  }
  return {
    text: `${text.slice(0, maxChars).trimEnd()}\n\n[truncated at ${maxChars} characters]`,
    truncated: true,
    originalChars: text.length,
  };
}

async function fetchArxivEntryById(id: string): Promise<ArxivEntry> {
  const params = new URLSearchParams({ id_list: id });
  const rows = parseArxivEntries(await fetchArxiv(params));
  const row = rows[0];
  if (!row) throw new Error(`No arXiv paper found for ${id}.`);
  return row;
}

export async function readArxivPaper(
  kwargs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = normalizeArxivId(kwargs.id ?? kwargs.arxiv_id ?? kwargs.ref);
  const entry = await fetchArxivEntryById(id);
  const canonicalId = entry.id || id.replace(/v\d+$/i, "");
  const pdfUrl = arxivPdfUrl(id);
  const outputDir = resolve(String(kwargs.output ?? "./arxiv-downloads"));
  const path = join(
    outputDir,
    arxivArtifactFilename({ id, title: entry.title }),
  );
  const download = await httpDownload(pdfUrl, path, {
    headers: {
      Accept: "application/pdf,*/*",
      Referer: arxivAbsUrl(canonicalId),
      "User-Agent": "unicli-arxiv/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
    },
  });
  if (download.status === "failed" || !download.path) {
    throw new Error(
      `arXiv PDF download failed for ${id}: ${download.error ?? "no path"}.`,
    );
  }

  const { firstPage, lastPage } = requireArxivPageRange(
    kwargs["first-page"] ?? kwargs.firstPage,
    kwargs["last-page"] ?? kwargs.lastPage,
  );
  const maxChars = requireArxivMaxChars(
    kwargs["max-chars"] ?? kwargs.maxChars,
    40_000,
  );
  const { stdout } = await execFileAsync(
    "pdftotext",
    [
      "-layout",
      "-enc",
      "UTF-8",
      "-f",
      String(firstPage),
      "-l",
      String(lastPage),
      download.path,
      "-",
    ],
    { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
  );
  const text = stdout.trim();
  if (!text) {
    throw new Error(
      `pdftotext returned no text for arXiv ${id} pages ${firstPage}-${lastPage}.`,
    );
  }
  const truncated = truncateText(text, maxChars);
  return {
    id: canonicalId,
    title: entry.title,
    authors: entry.authors
      .split(/\s*,\s*/)
      .map((author) => author.trim())
      .filter(Boolean),
    year: Number(entry.published.slice(0, 4)) || undefined,
    date: entry.published,
    venue: "arXiv",
    type: "preprint",
    abstract: entry.abstract,
    arxiv_id: canonicalId,
    source_adapter: "arxiv",
    source_url: arxivAbsUrl(canonicalId),
    pdf_url: pdfUrl,
    path: download.path,
    text: truncated.text,
    text_chars: truncated.originalChars,
    text_truncated: truncated.truncated,
    text_source: "pdf",
    retrieved_at: new Date().toISOString(),
  };
}

cli({
  site: "arxiv",
  name: "search",
  description: "Search arXiv papers with precise natural or fielded queries",
  domain: "export.arxiv.org",
  strategy: Strategy.PUBLIC,
  adapter_path: "src/adapters/arxiv/papers.ts",
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "Natural-language terms or explicit arXiv query syntax",
    },
    { name: "limit", type: "int", default: 10, description: "Max papers" },
    {
      name: "sort",
      type: "str",
      default: "relevance",
      choices: ["relevance", "submittedDate"],
      description: "Sort by relevance or newest submission",
    },
  ],
  columns: ["title", "authors", "published", "id"],
  operation_effect: "read",
  execution_operator: "structured-api",
  retrieval: {
    operation: "discover",
    result_kind: "paper",
    source_class: "hosted-artifact",
    arguments: { query: "query", limit: "limit", sort: "sort" },
  },
  capabilities: ["http.fetch", "scholar.search"],
  minimum_capability: "http.fetch",
  func: async (_page, kwargs, context) =>
    searchArxivPapers(kwargs, context?.signal),
});

cli({
  site: "arxiv",
  name: "author",
  description: "List arXiv papers by a given author",
  domain: "export.arxiv.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "author",
      type: "str",
      required: true,
      positional: true,
      description: "Author name",
    },
    { name: "limit", type: "int", default: 20, description: "Max papers" },
  ],
  columns: ["id", "title", "authors", "published", "primary_category", "url"],
  capabilities: ["http.fetch", "scholar.author", "scholar.search"],
  func: async (_page, kwargs) => {
    const author = requireArxivAuthor(kwargs.author);
    const limit = requireArxivLimit(kwargs.limit, 20);
    const params = new URLSearchParams({
      search_query: `au:"${author}"`,
      max_results: String(limit),
      sortBy: "submittedDate",
      sortOrder: "descending",
    });
    const rows = compactRows(parseArxivEntries(await fetchArxiv(params)));
    if (rows.length === 0) {
      throw new Error(`No arXiv papers found for author "${author}".`);
    }
    return rows;
  },
});

cli({
  site: "arxiv",
  name: "read",
  description: "Download an arXiv PDF by ID and extract text with pdftotext",
  domain: "arxiv.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "id",
      type: "str",
      required: true,
      positional: true,
      description: "arXiv paper ID (e.g. 1706.03762)",
      "x-unicli-kind": "id",
      "x-unicli-accepts": ["url"],
    },
    {
      name: "output",
      type: "str",
      default: "./arxiv-downloads",
      description: "Output directory",
      "x-unicli-kind": "path",
    },
    {
      name: "first-page",
      type: "int",
      default: 1,
      description: "First PDF page to extract",
    },
    {
      name: "last-page",
      type: "int",
      default: 20,
      description: "Last PDF page to extract",
    },
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
  func: async (_page, kwargs) => [await readArxivPaper(kwargs)],
});

cli({
  site: "arxiv",
  name: "recent",
  description: "List recent arXiv submissions in a category",
  domain: "export.arxiv.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "category",
      type: "str",
      required: true,
      positional: true,
      description: "arXiv category",
    },
    { name: "limit", type: "int", default: 10, description: "Max papers" },
  ],
  columns: ["id", "title", "authors", "published", "primary_category", "url"],
  capabilities: ["http.fetch", "scholar.search", "scholar.venue"],
  func: async (_page, kwargs) => {
    const category = requireArxivCategory(kwargs.category);
    const limit = requireArxivLimit(kwargs.limit, 10);
    const params = new URLSearchParams({
      search_query: `cat:${category}`,
      max_results: String(limit),
      sortBy: "submittedDate",
      sortOrder: "descending",
    });
    const rows = compactRows(parseArxivEntries(await fetchArxiv(params)));
    if (rows.length === 0) {
      throw new Error(`No recent arXiv papers found in ${category}.`);
    }
    return rows;
  },
});
