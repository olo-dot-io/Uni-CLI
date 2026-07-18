/**
 * @owner   src/adapters/arxiv/papers.ts
 * @does    Register agent-facing arXiv author, recent category, and PDF text-read commands.
 * @needs   export.arxiv.org Atom API, arxiv.org PDF URLs, category/id validation, conservative XML parsing, pdftotext.
 * @feeds   surface coverage ledger, scholarly search/read workflow, arXiv category monitoring.
 * @breaks  arXiv Atom/PDF shape drift, weak category/id parsing, denied PDF downloads, missing pdftotext, or silent empty feeds hide paper discovery/read failures.
 * @invariants  arXiv ids are normalized before URL construction; read returns PDF-derived text only and labels `text_source=pdf`.
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

async function fetchArxiv(params: URLSearchParams): Promise<string> {
  const response = await fetch(`${ARXIV_BASE}?${params.toString()}`, {
    headers: {
      "User-Agent": "unicli-arxiv/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
      Accept: "application/atom+xml, application/xml, text/xml",
    },
  });
  if (!response.ok)
    throw new Error(`arXiv API returned HTTP ${response.status}.`);
  return response.text();
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
