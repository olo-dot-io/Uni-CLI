/**
 * @owner       src::adapters::neurips::proceedings
 * @does        Registers NeurIPS proceedings search, paper detail retrieval, and PDF text reading over official paper pages.
 * @needs       proceedings.neurips.cc static HTML/PDFs, src/adapters/scholar-artifacts/pdf-read.ts, src/registry.ts
 * @feeds       src/commands/scholar.ts via scholar.search, scholar.get, scholar.pdf, scholar.fulltext, and scholar.venue
 * @breaks      NeurIPS markup/PDF drift, denied downloads, or missing pdftotext surface as explicit adapter errors; no unrelated source fallback is used.
 * @invariants  Year is explicit; paper detail prefers citation_* metadata and official /file/ PDF URLs.
 * @side-effects HTTPS egress to proceedings.neurips.cc; read writes one PDF artifact and executes pdftotext.
 * @perf        O(N) over one proceedings HTML page; read is O(PDF bytes + selected pages)
 * @concurrency safe
 * @test        tests/unit/adapters/scholar-sources.test.ts
 * @stability   experimental
 * @since       2026-05-19
 */

import { cli, Strategy } from "../../registry.js";
import type { ScholarlyWorkRecord } from "../../types/scholarly.js";
import { readScholarPdf } from "../scholar-artifacts/pdf-read.js";

const ORIGIN = "https://proceedings.neurips.cc";
const NEURIPS_USER_AGENT =
  "unicli-neurips/1.0 (https://github.com/olo-dot-io/Uni-CLI)";

type NeuripsActionableError = Error & {
  code?: string;
  suggestion?: string;
  retryable?: boolean;
  alternatives?: string[];
};

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

function absolute(path: string): string {
  return /^https?:\/\//i.test(path)
    ? path
    : `${ORIGIN}${path.startsWith("/") ? "" : "/"}${path}`;
}

function metaContents(html: string, name: string): string[] {
  const values: string[] = [];
  const re = new RegExp(
    `<meta\\s+name=["']${name}["']\\s+content=["']([^"']*)["'][^>]*>`,
    "gi",
  );
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) values.push(decode(match[1]));
  return values;
}

function firstMetaContent(html: string, name: string): string {
  return metaContents(html, name)[0] ?? "";
}

function requireYear(value: unknown): string {
  const year = String(value ?? "").trim();
  if (!/^\d{4}$/.test(year))
    throw new Error(`neurips year "${year}" is not valid.`);
  return year;
}

function requireNeuripsPaperId(value: unknown): string {
  const raw = String(value ?? "").trim();
  const id =
    raw
      .match(/\/(?:hash|file)\/([^/?#]+\.html)/)?.[1]
      ?.replace(/\.html$/, "") ?? raw.replace(/\.html$/, "");
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) {
    throw new Error(`NeurIPS paper id "${raw}" is not valid.`);
  }
  return id;
}

function abstractUrl(id: string, year: string): string {
  return `${ORIGIN}/paper_files/paper/${year}/hash/${id}.html`;
}

function pdfUrlFromAbstractUrl(sourceUrl: string): string {
  return sourceUrl
    .replace("/hash/", "/file/")
    .replace("-Abstract-", "-Paper-")
    .replace(/\.html$/, ".pdf");
}

function neuripsUpstreamError(
  label: string,
  detail: string,
): NeuripsActionableError {
  const error = new Error(
    `${label} failed: ${detail}.`,
  ) as NeuripsActionableError;
  error.code = "upstream_error";
  error.suggestion =
    "NeurIPS proceedings did not return the expected public paper page on this network path; retry later or verify the official proceedings.neurips.cc page manually.";
  error.retryable =
    /fetch failed|timeout|ECONNRESET|ETIMEDOUT|HTTP (429|5\d\d)/i.test(detail);
  error.alternatives = [];
  return error;
}

export function parseNeuripsPaperPage(
  html: string,
  sourceUrl: string,
): ScholarlyWorkRecord {
  const title =
    firstMetaContent(html, "citation_title") ||
    decode(
      html
        .match(/<h1 class="paper-title">([\s\S]*?)<\/h1>/i)?.[1]
        ?.replace(/<[^>]+>/g, " ") ?? "",
    );
  if (!title) throw new Error("NeurIPS paper page did not expose a title.");
  const year =
    firstMetaContent(html, "citation_publication_date").match(/\d{4}/)?.[0] ??
    sourceUrl.match(/\/paper\/(\d{4})\//)?.[1];
  const id =
    sourceUrl
      .split("/")
      .pop()
      ?.replace(/\.html$/, "") ?? title;
  const pdfUrl =
    firstMetaContent(html, "citation_pdf_url") ||
    html.match(/href=["']([^"']+-Paper-[^"']+\.pdf)["']/i)?.[1] ||
    "";
  return {
    id,
    title,
    authors: metaContents(html, "citation_author"),
    year: year ? Number(year) : undefined,
    venue: "NeurIPS",
    type: firstMetaContent(html, "citation_journal_title") || undefined,
    doi: firstMetaContent(html, "citation_doi") || undefined,
    abstract:
      decode(
        html
          .match(/<p class="paper-abstract">([\s\S]*?)<\/p>\s*<\/p>/i)?.[1]
          ?.replace(/<[^>]+>/g, " ") ?? "",
      ) || undefined,
    pdf_url: pdfUrl ? absolute(pdfUrl) : undefined,
    source_adapter: "neurips",
    source_url: sourceUrl,
    retrieved_at: new Date().toISOString(),
  };
}

export function parseNeuripsRows(
  html: string,
  year = "2024",
): ScholarlyWorkRecord[] {
  const out: ScholarlyWorkRecord[] = [];
  const re =
    /<div class="paper-content">[\s\S]*?<a title="paper title" href="([^"]+)">([\s\S]*?)<\/a>[\s\S]*?<span class="paper-authors">([\s\S]*?)<\/span>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const sourceUrl = absolute(match[1]);
    out.push({
      id:
        sourceUrl
          .split("/")
          .pop()
          ?.replace(/\.html$/, "") ?? decode(match[2]),
      title: decode(match[2].replace(/<[^>]+>/g, " ")),
      authors: decode(match[3])
        .split(",")
        .map((author) => author.trim())
        .filter(Boolean),
      year: Number(year),
      venue: "NeurIPS",
      pdf_url: pdfUrlFromAbstractUrl(sourceUrl),
      source_adapter: "neurips",
      source_url: sourceUrl,
      retrieved_at: new Date().toISOString(),
    });
  }
  return out;
}

async function fetchNeuripsHtml(url: string, label: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "text/html",
        "User-Agent": NEURIPS_USER_AGENT,
      },
    });
  } catch (error) {
    throw neuripsUpstreamError(
      label,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (response.status === 404) throw new Error(`${label} returned no page.`);
  if (!response.ok)
    throw neuripsUpstreamError(label, `HTTP ${response.status}`);
  return response.text();
}

async function readNeuripsPaperPdf(
  row: ScholarlyWorkRecord,
  kwargs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!row.pdf_url) throw new Error(`NeurIPS paper ${row.id} has no PDF URL.`);
  return readScholarPdf(
    {
      id: row.id,
      title: row.title,
      source_adapter: "neurips",
      source_url: row.source_url,
      pdf_url: row.pdf_url,
      output: kwargs.output,
      filename: kwargs.filename,
      "first-page": kwargs["first-page"] ?? kwargs.firstPage,
      "last-page": kwargs["last-page"] ?? kwargs.lastPage,
      "max-chars": kwargs["max-chars"] ?? kwargs.maxChars,
    },
    {
      site: "neurips",
      command: "read",
      defaultOutput: "./neurips-downloads",
      userAgent: NEURIPS_USER_AGENT,
    },
  );
}

cli({
  site: "neurips",
  name: "search",
  description: "Search NeurIPS proceedings by year",
  domain: "proceedings.neurips.cc",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "year", type: "str", default: "2024" },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["id", "title", "authors", "year", "venue", "pdf_url", "source_url"],
  capabilities: [
    "http.fetch",
    "scholar.search",
    "scholar.venue",
    "scholar.pdf",
  ],
  func: async (_page, kwargs) => {
    const query = String(kwargs.query ?? "")
      .trim()
      .toLowerCase();
    if (!query) throw new Error("neurips search query cannot be empty.");
    const year = requireYear(kwargs.year);
    const limit = Math.min(Math.max(Number(kwargs.limit ?? 20), 1), 200);
    const rows = parseNeuripsRows(
      await fetchNeuripsHtml(
        `${ORIGIN}/paper_files/paper/${year}`,
        `NeurIPS ${year}`,
      ),
      year,
    )
      .filter((row) =>
        `${row.title} ${row.authors?.join(" ") ?? ""}`
          .toLowerCase()
          .includes(query),
      )
      .slice(0, limit);
    if (rows.length === 0)
      throw new Error(`No NeurIPS ${year} papers matched "${query}".`);
    return rows;
  },
});

cli({
  site: "neurips",
  name: "paper",
  description: "Fetch NeurIPS proceedings paper metadata by page id",
  domain: "proceedings.neurips.cc",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "id", type: "str", required: true, positional: true },
    { name: "year", type: "str", default: "2024" },
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
  capabilities: ["http.fetch", "scholar.get", "scholar.pdf"],
  func: async (_page, kwargs) => {
    const year = requireYear(kwargs.year);
    const id = requireNeuripsPaperId(kwargs.id ?? kwargs.ref);
    const url = abstractUrl(id, year);
    return [
      parseNeuripsPaperPage(
        await fetchNeuripsHtml(url, `NeurIPS paper ${id}`),
        url,
      ),
    ];
  },
});

cli({
  site: "neurips",
  name: "read",
  description:
    "Download a NeurIPS proceedings paper PDF by page id and extract text",
  domain: "proceedings.neurips.cc",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "id", type: "str", required: true, positional: true },
    { name: "year", type: "str", default: "2024" },
    {
      name: "output",
      type: "str",
      default: "./neurips-downloads",
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
    const year = requireYear(kwargs.year);
    const id = requireNeuripsPaperId(kwargs.id ?? kwargs.ref);
    const url = abstractUrl(id, year);
    const row = parseNeuripsPaperPage(
      await fetchNeuripsHtml(url, `NeurIPS paper ${id}`),
      url,
    );
    return [await readNeuripsPaperPdf(row, kwargs)];
  },
});
