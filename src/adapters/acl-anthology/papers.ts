/**
 * @owner       src::adapters::acl-anthology::papers
 * @does        Registers ACL Anthology paper search, metadata lookup, PDF download, and PDF text-read commands from official Anthology pages.
 * @needs       aclanthology.org static search/paper HTML, scholar-artifacts PDF reader, src/registry.ts
 * @feeds       src/commands/scholar.ts via scholar.search, scholar.get, scholar.pdf, scholar.fulltext, and scholar.venue
 * @breaks      ACL Anthology markup drift, denied PDF downloads, missing pdftotext, or empty PDF text surfaces as source read failure.
 * @invariants  Paper URLs/PDF URLs are absolutized against aclanthology.org; read output labels `text_source=pdf`.
 * @side-effects HTTPS egress to aclanthology.org; read writes PDFs under the requested output directory and executes pdftotext.
 * @perf        O(N) over one HTML response for search; O(PDF bytes + extracted pages) for read.
 * @concurrency safe
 * @test        src/adapters/acl-anthology/papers.test.ts, tests/unit/adapters/scholar-sources.test.ts
 * @stability   experimental
 * @since       2026-05-19
 */

import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

import { cli, Strategy } from "../../registry.js";
import { httpDownload, sanitizeFilename } from "../../engine/download.js";
import type { ScholarlyWorkRecord } from "../../types/scholarly.js";

const ORIGIN = "https://aclanthology.org";
const ANTHOLOGY_BIB_URL = `${ORIGIN}/anthology.bib.gz`;
const execFileAsync = promisify(execFile);
let anthologyBibCache: Promise<string> | undefined;

function decode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanAclHtml(value: string): string {
  return decode(value.replace(/<[^>]+>/g, ""));
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeAclAnthologyId(value: unknown): string {
  const raw = String(value ?? "")
    .trim()
    .replace(/^https?:\/\/(?:www\.)?aclanthology\.org\//i, "")
    .replace(/\.pdf$/i, "")
    .replace(/\/$/i, "");
  if (!/^[A-Za-z0-9.-]+$/.test(raw)) {
    throw new Error(`ACL Anthology id "${String(value ?? "")}" is not valid.`);
  }
  return raw.replace(/\.$/, "");
}

export function aclAnthologyPdfUrl(id: string): string {
  return `${ORIGIN}/${id}.pdf`;
}

function cleanBibValue(value: string): string {
  return decode(
    value
      .trim()
      .replace(/,$/, "")
      .replace(/^["{]|["}]$/g, "")
      .replace(/\\"/g, '"')
      .replace(/\\&/g, "&")
      .replace(/\\url\{([^}]+)\}/g, "$1")
      .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, "$1")
      .replace(/[{}]/g, "")
      .replace(/\s+/g, " "),
  );
}

function normalizeBibAuthors(value: string): string[] | undefined {
  const authors = cleanBibValue(value)
    .split(/\s+and\s+/)
    .map((author) => {
      const parts = author.split(/\s*,\s*/);
      return parts.length === 2 ? `${parts[1]} ${parts[0]}` : author;
    })
    .map((author) => author.trim())
    .filter(Boolean);
  return authors.length > 0 ? authors.slice(0, 20) : undefined;
}

function parseBibFields(entry: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const re =
    /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*([\s\S]*?)(?=,\n\s*[A-Za-z][A-Za-z0-9_-]*\s*=|\n}\s*$)/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(entry)) !== null) {
    fields[match[1].toLowerCase()] = match[2];
  }
  return fields;
}

export function parseAclBibEntries(bib: string): ScholarlyWorkRecord[] {
  const rows: ScholarlyWorkRecord[] = [];
  for (const entry of bib.split(/\n(?=@[A-Za-z]+\{)/)) {
    const header = entry.match(/^@([A-Za-z]+)\{([^,]+),/);
    if (!header) continue;
    const fields = parseBibFields(entry);
    const title = fields.title ? cleanBibValue(fields.title) : "";
    const sourceUrl = fields.url ? cleanBibValue(fields.url) : "";
    const id = sourceUrl
      ? normalizeAclAnthologyId(sourceUrl)
      : normalizeAclAnthologyId(header[2]);
    if (!title || !id) continue;
    const year = fields.year ? Number(cleanBibValue(fields.year)) : undefined;
    const doi = fields.doi ? cleanBibValue(fields.doi) : undefined;
    rows.push({
      id,
      title,
      authors: fields.author ? normalizeBibAuthors(fields.author) : undefined,
      year: Number.isInteger(year) ? year : undefined,
      venue: fields.booktitle
        ? cleanBibValue(fields.booktitle)
        : "ACL Anthology",
      doi,
      pdf_url: aclAnthologyPdfUrl(id),
      source_adapter: "acl-anthology",
      source_url: `${ORIGIN}/${id}/`,
      retrieved_at: new Date().toISOString(),
    });
  }
  return rows;
}

function scoreAclBibRow(row: ScholarlyWorkRecord, query: string): number {
  const normalizedQuery = normalizeSearchText(query);
  const terms = normalizedQuery.split(" ").filter(Boolean);
  const title = normalizeSearchText(row.title);
  const authors = normalizeSearchText((row.authors ?? []).join(" "));
  const haystack = normalizeSearchText(
    [
      row.id,
      row.title,
      row.venue,
      row.year,
      row.doi,
      (row.authors ?? []).join(" "),
    ]
      .filter(Boolean)
      .join(" "),
  );
  if (!normalizedQuery || !terms.every((term) => haystack.includes(term))) {
    return 0;
  }
  let score = 10;
  if (row.id.toLowerCase() === normalizedQuery) score += 100;
  if (title === normalizedQuery) score += 80;
  if (title.includes(normalizedQuery)) score += 40;
  if (authors.includes(normalizedQuery)) score += 20;
  return score + Math.min(Number(row.year ?? 0) / 10_000, 1);
}

export function searchAclBibRows(
  rows: readonly ScholarlyWorkRecord[],
  query: string,
  limit: number,
): ScholarlyWorkRecord[] {
  return rows
    .map((row, index) => ({
      row,
      index,
      score: scoreAclBibRow(row, query),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((candidate) => candidate.row);
}

export function requireAclReadPageArgs(
  kwargs: Record<string, unknown>,
): Record<string, unknown> {
  return {
    first_page: kwargs["first-page"] ?? kwargs.firstPage,
    last_page: kwargs["last-page"] ?? kwargs.lastPage,
    max_chars: kwargs["max-chars"] ?? kwargs.maxChars,
  };
}

export function aclArtifactFilename(record: ScholarlyWorkRecord): string {
  const title = sanitizeFilename(String(record.title ?? ""))
    .replace(/\s+/g, "_")
    .slice(0, 96);
  return `${sanitizeFilename(record.id)}${title ? `-${title}` : ""}.pdf`;
}

function requireAclPageRange(
  firstPage: unknown,
  lastPage: unknown,
): { firstPage: number; lastPage: number } {
  const first = Number(firstPage ?? 1);
  const last = Number(lastPage ?? 20);
  if (!Number.isInteger(first) || first < 1) {
    throw new Error("acl-anthology first-page must be an integer >= 1.");
  }
  if (!Number.isInteger(last) || last < first) {
    throw new Error(
      "acl-anthology last-page must be an integer >= first-page.",
    );
  }
  return { firstPage: first, lastPage: last };
}

function requireAclMaxChars(value: unknown, fallback = 40_000): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1_000 || n > 1_000_000) {
    throw new Error(
      `acl-anthology max-chars must be an integer in [1000, 1000000]. Got: ${String(value)}`,
    );
  }
  return n;
}

function truncateAclText(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean; originalChars: number } {
  if (text.length <= maxChars) {
    return { text, truncated: false, originalChars: text.length };
  }
  return {
    text: `${text.slice(0, maxChars).trimEnd()}\n\n[truncated at ${maxChars} characters]`,
    truncated: true,
    originalChars: text.length,
  };
}

async function fetchHtml(url: string, label: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html",
      "User-Agent":
        "unicli-acl-anthology/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
    },
  });
  if (response.status === 404) throw new Error(`${label} returned no result.`);
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}.`);
  return response.text();
}

async function fetchAnthologyBib(): Promise<string> {
  anthologyBibCache ??= (async () => {
    const response = await fetch(ANTHOLOGY_BIB_URL, {
      headers: {
        Accept: "application/x-gzip, application/gzip, */*",
        "User-Agent":
          "unicli-acl-anthology/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
      },
    });
    if (!response.ok)
      throw new Error(`ACL Anthology BibTeX returned HTTP ${response.status}.`);
    return gunzipSync(Buffer.from(await response.arrayBuffer())).toString(
      "utf8",
    );
  })();
  return anthologyBibCache;
}

async function fetchAclPaperRecord(id: string): Promise<ScholarlyWorkRecord> {
  const html = await fetchHtml(`${ORIGIN}/${id}/`, `acl-anthology paper ${id}`);
  const title = cleanAclHtml(
    html.match(/<h2[^>]*id=title[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? "",
  );
  if (!title)
    throw new Error(`ACL Anthology paper ${id} did not expose a title.`);
  return {
    id,
    title,
    year: Number(id.slice(0, 4)) || undefined,
    venue: "ACL Anthology",
    pdf_url: aclAnthologyPdfUrl(id),
    source_adapter: "acl-anthology",
    source_url: `${ORIGIN}/${id}/`,
    retrieved_at: new Date().toISOString(),
  };
}

async function readAclPaperPdf(
  record: ScholarlyWorkRecord,
  kwargs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!record.pdf_url) {
    throw new Error(`ACL Anthology paper ${record.id} did not expose a PDF.`);
  }
  const outputDir = resolve(
    String(kwargs.output ?? "./acl-anthology-downloads"),
  );
  const path = join(outputDir, aclArtifactFilename(record));
  const download = await httpDownload(record.pdf_url, path, {
    Accept: "application/pdf,*/*",
    Referer: record.source_url ?? `${ORIGIN}/${record.id}/`,
    "User-Agent":
      "unicli-acl-anthology/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
  });
  if (download.status === "failed" || !download.path) {
    throw new Error(
      `ACL Anthology PDF download failed for ${record.id}: ${download.error ?? "no path"}.`,
    );
  }

  const pageArgs = requireAclReadPageArgs(kwargs);
  const { firstPage, lastPage } = requireAclPageRange(
    pageArgs.first_page,
    pageArgs.last_page,
  );
  const maxChars = requireAclMaxChars(pageArgs.max_chars);
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
  const extracted = stdout.trim();
  if (!extracted) {
    throw new Error(
      `pdftotext returned no text for ACL Anthology ${record.id} pages ${firstPage}-${lastPage}.`,
    );
  }
  const truncated = truncateAclText(extracted, maxChars);
  return {
    ...record,
    path: download.path,
    text: truncated.text,
    text_chars: truncated.originalChars,
    text_truncated: truncated.truncated,
    text_source: "pdf",
  };
}

cli({
  site: "acl-anthology",
  name: "search",
  description: "Search ACL Anthology papers",
  domain: "aclanthology.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["id", "title", "authors", "year", "venue", "pdf_url", "source_url"],
  capabilities: ["http.fetch", "scholar.search", "scholar.pdf"],
  func: async (_page, kwargs) => {
    const query = String(kwargs.query ?? "").trim();
    if (!query) throw new Error("acl-anthology search query cannot be empty.");
    const limit = Math.min(Math.max(Number(kwargs.limit ?? 20), 1), 100);
    const rows = searchAclBibRows(
      parseAclBibEntries(await fetchAnthologyBib()),
      query,
      limit,
    );
    if (rows.length === 0)
      throw new Error(`No ACL Anthology papers matched "${query}".`);
    return rows;
  },
});

cli({
  site: "acl-anthology",
  name: "paper",
  description: "Fetch an ACL Anthology paper by anthology id",
  domain: "aclanthology.org",
  strategy: Strategy.PUBLIC,
  args: [{ name: "id", type: "str", required: true, positional: true }],
  columns: ["id", "title", "authors", "year", "venue", "pdf_url", "source_url"],
  capabilities: ["http.fetch", "scholar.get", "scholar.pdf"],
  func: async (_page, kwargs) => {
    const id = normalizeAclAnthologyId(kwargs.id ?? kwargs.ref);
    return [await fetchAclPaperRecord(id)];
  },
});

cli({
  site: "acl-anthology",
  name: "read",
  description: "Download an ACL Anthology paper PDF by id and extract text",
  domain: "aclanthology.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "id",
      type: "str",
      required: true,
      positional: true,
      description: "ACL Anthology paper id (e.g. 2020.acl-main.447)",
      "x-unicli-kind": "id",
      "x-unicli-accepts": ["url"],
    },
    {
      name: "output",
      type: "str",
      default: "./acl-anthology-downloads",
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
  func: async (_page, kwargs) => {
    const id = normalizeAclAnthologyId(kwargs.id ?? kwargs.ref);
    const record = await fetchAclPaperRecord(id);
    return [await readAclPaperPdf(record, kwargs)];
  },
});
