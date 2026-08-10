/**
 * @owner       src::adapters::cvf::papers
 * @does        Registers CVF OpenAccess conference paper search, detail retrieval, and PDF text reading for CVPR/ICCV/ECCV-style proceedings pages.
 * @needs       openaccess.thecvf.com static proceedings HTML/PDFs, src/adapters/scholar-artifacts/pdf-read.ts, src/registry.ts
 * @feeds       src/commands/scholar.ts via scholar.search, scholar.get, scholar.pdf, scholar.fulltext, and scholar.venue
 * @breaks      CVF markup/PDF drift, denied downloads, or missing pdftotext surface as explicit adapter errors rather than non-CVF fallbacks.
 * @invariants  Venue/year map to explicit CVF event pages; paper detail prefers citation_* metadata over scraped display blocks.
 * @side-effects HTTPS egress to openaccess.thecvf.com; read writes one PDF artifact and executes pdftotext.
 * @perf        O(N) over one proceedings HTML page; read is O(PDF bytes + selected pages)
 * @concurrency safe
 * @test        tests/unit/adapters/scholar-sources.test.ts
 * @stability   experimental
 * @since       2026-05-19
 */

import { cli, Strategy } from "../../registry.js";
import type { ScholarlyWorkRecord } from "../../types/scholarly.js";
import { readScholarPdf } from "../scholar-artifacts/pdf-read.js";
import { Agent, request } from "undici";

const ORIGIN = "https://openaccess.thecvf.com";
const CVF_USER_AGENT = "unicli-cvf/1.0 (https://github.com/olo-dot-io/Uni-CLI)";
const CVF_HTTP_AGENT = new Agent({ connect: { timeout: 30_000 } });
export const CVF_HTTP_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "User-Agent": CVF_USER_AGENT,
} as const;

type CvfActionableError = Error & {
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

function parseYear(value: string): number | undefined {
  const year = value.match(/\d{4}/)?.[0];
  return year ? Number(year) : undefined;
}

function eventId(venue: unknown, year: unknown): string {
  const v = String(venue ?? "CVPR")
    .trim()
    .toUpperCase();
  const y = String(year ?? "").trim();
  if (!/^(CVPR|ICCV|ECCV|WACV)$/.test(v))
    throw new Error(`unsupported CVF venue: ${v}`);
  if (!/^\d{4}$/.test(y)) throw new Error(`cvf year "${y}" is not valid.`);
  return `${v}${y}`;
}

function requireCvfPaperId(value: unknown): string {
  const raw = String(value ?? "").trim();
  const id =
    raw.match(/\/html\/([^/?#]+\.html)/)?.[1]?.replace(/\.html$/, "") ??
    raw.replace(/\.html$/, "");
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) {
    throw new Error(`CVF paper id "${raw}" is not valid.`);
  }
  return id;
}

function paperUrl(id: string, event: string): string {
  return `${ORIGIN}/content/${event}/html/${id}.html`;
}

function cvfUpstreamError(label: string, detail: string): CvfActionableError {
  const error = new Error(`${label} failed: ${detail}.`) as CvfActionableError;
  error.code = "upstream_error";
  error.suggestion =
    "CVF OpenAccess did not return the expected public proceedings page on this network path; retry later or verify the official openaccess.thecvf.com page manually.";
  error.retryable =
    /fetch failed|timeout|ECONNRESET|ETIMEDOUT|HTTP (429|5\d\d)/i.test(detail);
  error.alternatives = [];
  return error;
}

function parseListAuthors(block: string): string[] | undefined {
  const beforeLinks = block.split(/\[<a\s+href=/i)[0] ?? block;
  const dd = beforeLinks.match(/<dd>([\s\S]*?)(?:<\/dd>|$)/i)?.[1] ?? "";
  const text = decode(
    dd.replace(/<div class="bibref[\s\S]*$/i, " ").replace(/<[^>]+>/g, " "),
  );
  const authors = text
    .replace(/;\s*Proceedings[\s\S]*$/i, "")
    .split(",")
    .map((author) => author.trim())
    .filter(Boolean);
  return authors.length > 0 ? authors : undefined;
}

export function parseCvfPaperPage(
  html: string,
  sourceUrl: string,
): ScholarlyWorkRecord {
  const title =
    firstMetaContent(html, "citation_title") ||
    decode(
      html
        .match(/<div id="papertitle">([\s\S]*?)<dd>/i)?.[1]
        ?.replace(/<[^>]+>/g, " ") ?? "",
    );
  if (!title) throw new Error("CVF paper page did not expose a title.");
  const event = sourceUrl.match(/\/content\/([A-Z]+\d{4})\//)?.[1] ?? undefined;
  const id =
    sourceUrl
      .split("/")
      .pop()
      ?.replace(/\.html$/, "") ?? title;
  const pdfUrl =
    firstMetaContent(html, "citation_pdf_url") ||
    html.match(/<a href="([^"]+\.pdf)">pdf<\/a>/i)?.[1] ||
    "";
  return {
    id,
    title,
    authors: metaContents(html, "citation_author"),
    year:
      parseYear(firstMetaContent(html, "citation_publication_date")) ??
      (event ? Number(event.slice(-4)) : undefined),
    venue:
      firstMetaContent(html, "citation_conference_title") ||
      event?.replace(/\d{4}$/, ""),
    abstract:
      decode(
        html.match(/<div id="abstract">([\s\S]*?)<\/div>/i)?.[1] ?? "",
      ).replace(/<[^>]+>/g, " ") || undefined,
    pdf_url: pdfUrl ? absolute(pdfUrl) : undefined,
    source_adapter: "cvf",
    source_url: sourceUrl,
    retrieved_at: new Date().toISOString(),
  };
}

export function parseCvfRows(
  html: string,
  event = "CVPR2024",
): ScholarlyWorkRecord[] {
  const out: ScholarlyWorkRecord[] = [];
  const re =
    /<dt class="ptitle">[\s\S]*?<a href="([^"]+)">([\s\S]*?)<\/a><\/dt>([\s\S]*?)(?=<dt class="ptitle">|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const sourceUrl = absolute(match[1]);
    const title = decode(match[2].replace(/<[^>]+>/g, " "));
    const block = match[3];
    const pdf = block.match(/<a href="([^"]+\.pdf)">pdf<\/a>/i)?.[1] ?? "";
    out.push({
      id:
        sourceUrl
          .split("/")
          .pop()
          ?.replace(/\.html$/, "") ?? title,
      title,
      authors: parseListAuthors(block),
      year: Number(event.slice(-4)),
      venue: event.replace(/\d{4}$/, ""),
      pdf_url: pdf ? absolute(pdf) : undefined,
      source_adapter: "cvf",
      source_url: sourceUrl,
      retrieved_at: new Date().toISOString(),
    });
  }
  return out;
}

async function fetchCvfHtml(url: string, label: string): Promise<string> {
  let response: Awaited<ReturnType<typeof request>>;
  try {
    response = await request(url, {
      dispatcher: CVF_HTTP_AGENT,
      headers: CVF_HTTP_HEADERS,
    });
  } catch (error) {
    throw cvfUpstreamError(
      label,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (response.statusCode === 404)
    throw new Error(`${label} returned no page.`);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw cvfUpstreamError(label, `HTTP ${response.statusCode}`);
  }
  return response.body.text();
}

async function readCvfPaperPdf(
  row: ScholarlyWorkRecord,
  kwargs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!row.pdf_url) throw new Error(`CVF paper ${row.id} has no PDF URL.`);
  return readScholarPdf(
    {
      id: row.id,
      title: row.title,
      source_adapter: "cvf",
      source_url: row.source_url,
      pdf_url: row.pdf_url,
      output: kwargs.output,
      filename: kwargs.filename,
      "first-page": kwargs["first-page"] ?? kwargs.firstPage,
      "last-page": kwargs["last-page"] ?? kwargs.lastPage,
      "max-chars": kwargs["max-chars"] ?? kwargs.maxChars,
    },
    {
      site: "cvf",
      command: "read",
      defaultOutput: "./cvf-downloads",
      userAgent: CVF_USER_AGENT,
    },
  );
}

cli({
  site: "cvf",
  name: "search",
  description: "Search CVF OpenAccess proceedings (CVPR/ICCV/ECCV/WACV)",
  domain: "openaccess.thecvf.com",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "venue", type: "str", default: "CVPR" },
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
    if (!query) throw new Error("cvf search query cannot be empty.");
    const event = eventId(kwargs.venue, kwargs.year);
    const limit = Math.min(Math.max(Number(kwargs.limit ?? 20), 1), 200);
    const rows = parseCvfRows(
      await fetchCvfHtml(`${ORIGIN}/${event}?day=all`, `CVF ${event}`),
      event,
    )
      .filter((row) =>
        `${row.title} ${row.authors?.join(" ") ?? ""}`
          .toLowerCase()
          .includes(query),
      )
      .slice(0, limit);
    if (rows.length === 0)
      throw new Error(`No CVF ${event} papers matched "${query}".`);
    return rows;
  },
});

cli({
  site: "cvf",
  name: "paper",
  description: "Fetch CVF OpenAccess paper metadata by page id",
  domain: "openaccess.thecvf.com",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "id", type: "str", required: true, positional: true },
    { name: "venue", type: "str", default: "CVPR" },
    { name: "year", type: "str", default: "2024" },
  ],
  columns: ["id", "title", "authors", "year", "venue", "pdf_url", "source_url"],
  capabilities: ["http.fetch", "scholar.get", "scholar.pdf"],
  func: async (_page, kwargs) => {
    const event = eventId(kwargs.venue, kwargs.year);
    const id = requireCvfPaperId(kwargs.id ?? kwargs.ref);
    const url = paperUrl(id, event);
    return [parseCvfPaperPage(await fetchCvfHtml(url, `CVF paper ${id}`), url)];
  },
});

cli({
  site: "cvf",
  name: "read",
  description:
    "Download a CVF OpenAccess paper PDF by page id and extract text",
  domain: "openaccess.thecvf.com",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "id", type: "str", required: true, positional: true },
    { name: "venue", type: "str", default: "CVPR" },
    { name: "year", type: "str", default: "2024" },
    {
      name: "output",
      type: "str",
      default: "./cvf-downloads",
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
  operation_family: "download",
  operation_effect: "download_file",
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
    const event = eventId(kwargs.venue, kwargs.year);
    const id = requireCvfPaperId(kwargs.id ?? kwargs.ref);
    const url = paperUrl(id, event);
    const row = parseCvfPaperPage(
      await fetchCvfHtml(url, `CVF paper ${id}`),
      url,
    );
    return [await readCvfPaperPdf(row, kwargs)];
  },
});
