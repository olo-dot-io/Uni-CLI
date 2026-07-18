/**
 * @owner       src::adapters::rxiv::preprints
 * @does        Provides shared bioRxiv/medRxiv official API search, mapping, PDF download, and read helpers for site-specific entrypoints.
 * @needs       api.biorxiv.org details API, bioRxiv/medRxiv PDF/JATS URLs, src/engine/download.ts, pdftotext.
 * @feeds       src/adapters/biorxiv/preprints.ts, src/adapters/medrxiv/preprints.ts, scholarly preprint workflows.
 * @breaks      API envelope drift, date-window search exhaustion, Cloudflare denial on PDF/XML assets, missing DOI versions, or pdftotext absence stop the preprint artifact loop.
 * @invariants  DOI detail and date-window search are source-first through the official API; read prefers JATS XML, then falls back to PDF text extraction; source-denied assets fail closed.
 * @side-effects HTTPS egress to api.biorxiv.org and source PDF/XML hosts; download/read may write PDFs under the requested output directory; read may execute pdftotext.
 * @perf        O(1) for DOI detail, O(limit) for recent mapping, O(max-pages * 30) for bounded search.
 * @concurrency safe - per-command local state only
 * @test        src/adapters/rxiv/preprints.test.ts, tests/unit/commands/scholar.test.ts
 * @stability   experimental
 * @since       0.225.2
 */

import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { DOMParser, type Document, type Element } from "@xmldom/xmldom";

import { httpDownload, sanitizeFilename } from "../../engine/download.js";
import { normalizeXmlText, stripHtml } from "../../engine/text-normalize.js";
import type { AdapterArg } from "../../types.js";

const API_BASE = "https://api.biorxiv.org/details";
const execFileAsync = promisify(execFile);
export const RXIV_RECENT_COLUMNS = [
  "rank",
  "id",
  "title",
  "authors",
  "date",
  "version",
  "category",
  "doi",
  "pdf_url",
  "source_url",
];
export const RXIV_SEARCH_COLUMNS = [
  ...RXIV_RECENT_COLUMNS,
  "matched_fields",
  "search_scope",
  "search_window",
  "search_scanned_records",
  "search_total_records",
  "search_exhaustive",
];
export const RXIV_PAPER_COLUMNS = [
  "id",
  "title",
  "authors",
  "date",
  "version",
  "type",
  "license",
  "category",
  "abstract",
  "doi",
  "jatsxml_url",
  "pdf_url",
  "source_url",
];
export const RXIV_DOWNLOAD_COLUMNS = [
  "id",
  "title",
  "doi",
  "pdf_url",
  "path",
  "_download",
];
export const RXIV_READ_COLUMNS = [
  "id",
  "title",
  "doi",
  "pdf_url",
  "path",
  "text_source",
  "text",
];
export const RXIV_RECENT_ARGS: AdapterArg[] = [
  {
    name: "from",
    type: "str" as const,
    description: "Start date YYYY-MM-DD; defaults to seven UTC days ago",
  },
  {
    name: "to",
    type: "str" as const,
    description: "End date YYYY-MM-DD; defaults to today UTC",
  },
  { name: "cursor", type: "int" as const, default: 0 },
  { name: "limit", type: "int" as const, default: 30 },
  {
    name: "category",
    type: "str" as const,
    description: "Optional subject category, e.g. epidemiology or cell_biology",
  },
];
export const RXIV_SEARCH_ARGS: AdapterArg[] = [
  {
    name: "query",
    type: "str" as const,
    required: true,
    positional: true,
    description:
      "Search text matched against title, abstract, authors, DOI, and category",
  },
  {
    name: "from",
    type: "str" as const,
    description: "Start date YYYY-MM-DD; defaults to seven UTC days ago",
  },
  {
    name: "to",
    type: "str" as const,
    description: "End date YYYY-MM-DD; defaults to today UTC",
  },
  { name: "cursor", type: "int" as const, default: 0 },
  { name: "limit", type: "int" as const, default: 20 },
  {
    name: "max-pages",
    type: "int" as const,
    default: 10,
    description:
      "Maximum official API pages to scan; each page contains up to 30 records",
  },
  {
    name: "category",
    type: "str" as const,
    description: "Optional subject category, e.g. epidemiology or cell_biology",
  },
];
export const RXIV_PAPER_ARGS: AdapterArg[] = [
  {
    name: "doi",
    type: "str" as const,
    required: true,
    positional: true,
    description: "Preprint DOI",
    "x-unicli-kind": "id",
    "x-unicli-accepts": ["url"],
  },
];
export const RXIV_DOWNLOAD_ARGS: AdapterArg[] = [
  ...RXIV_PAPER_ARGS,
  {
    name: "output",
    type: "str" as const,
    default: "./rxiv-downloads",
    description: "Output directory",
    "x-unicli-kind": "path",
  },
];
export const RXIV_READ_ARGS: AdapterArg[] = [
  ...RXIV_DOWNLOAD_ARGS,
  {
    name: "first-page",
    type: "int" as const,
    default: 1,
    description: "First PDF page to extract when JATS XML is unavailable",
  },
  {
    name: "last-page",
    type: "int" as const,
    default: 20,
    description: "Last PDF page to extract when JATS XML is unavailable",
  },
  {
    name: "max-chars",
    type: "int" as const,
    default: 40000,
    description: "Maximum text characters to return",
  },
];
export const RXIV_RECENT_CAPABILITIES = [
  "http.fetch",
  "scholar.venue",
] as const;
export const RXIV_SEARCH_CAPABILITIES = [
  "http.fetch",
  "scholar.search",
] as const;
export const RXIV_PAPER_CAPABILITIES = [
  "http.fetch",
  "scholar.get",
  "scholar.pdf",
] as const;
export const RXIV_DOWNLOAD_CAPABILITIES = [
  "http.fetch",
  "http.download",
  "scholar.pdf",
] as const;
export const RXIV_READ_CAPABILITIES = [
  "http.fetch",
  "http.download",
  "subprocess.exec",
  "scholar.fulltext",
  "scholar.pdf",
] as const;

type RxivSite = "biorxiv" | "medrxiv";

export interface RxivConfig {
  site: RxivSite;
  label: string;
  apiServer: string;
  webOrigin: string;
}

export interface RxivPreprint {
  title?: unknown;
  authors?: unknown;
  author_corresponding?: unknown;
  author_corresponding_institution?: unknown;
  doi?: unknown;
  date?: unknown;
  version?: unknown;
  type?: unknown;
  license?: unknown;
  category?: unknown;
  jatsxml?: unknown;
  abstract?: unknown;
  published?: unknown;
  server?: unknown;
}

interface RxivEnvelope {
  messages?: Array<{ status?: unknown; count?: unknown; total?: unknown }>;
  collection?: RxivPreprint[];
}

type RxivActionableError = Error & {
  code?: string;
  suggestion?: string;
  retryable?: boolean;
  alternatives?: string[];
};

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanText(value: unknown): string {
  return normalizeXmlText(stringField(value));
}

function rxivAssetError(
  config: RxivConfig,
  kind: "PDF" | "JATS XML",
  doi: string,
  detail: string,
): RxivActionableError {
  const error = new Error(
    `${config.label} ${kind} source asset failed for ${doi}: ${detail}.`,
  ) as RxivActionableError;
  error.code = "upstream_error";
  error.suggestion = `${config.label} source asset host rejected ${kind} access on this network path; use the official API metadata, retry later, or open the source URL manually. Do not assume a cookie/login repair will fix this public asset response.`;
  error.retryable = /HTTP 5\d\d|timeout|ECONNRESET|ETIMEDOUT/i.test(detail);
  error.alternatives = [];
  return error;
}

function bareDoi(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/^doi:/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/\\\//g, "/");
}

export function requireRxivDoi(value: unknown, site = "rxiv"): string {
  const doi = bareDoi(value);
  if (!/^10\.\S+\/\S+$/i.test(doi)) {
    throw new Error(`${site} DOI "${String(value ?? "")}" is not recognised.`);
  }
  return doi;
}

export function requireRxivLimit(value: unknown, fallback = 30): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 30) {
    throw new Error(
      `rxiv limit must be an integer in [1, 30]. Got: ${String(value)}`,
    );
  }
  return n;
}

export function requireRxivSearchPages(value: unknown, fallback = 10): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 20) {
    throw new Error(
      `rxiv max-pages must be an integer in [1, 20]. Got: ${String(value)}`,
    );
  }
  return n;
}

export function requireRxivQuery(value: unknown): string {
  const query = cleanText(value);
  if (!query) throw new Error("rxiv query cannot be empty.");
  return query;
}

export function requireRxivCursor(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("rxiv cursor must be a non-negative integer.");
  }
  return n;
}

export function requireRxivDate(value: unknown, label: string): string {
  const date = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`rxiv ${label} must be YYYY-MM-DD.`);
  }
  return date;
}

export function requireRxivMaxChars(value: unknown, fallback = 40_000): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1_000 || n > 1_000_000) {
    throw new Error(
      `rxiv max-chars must be an integer in [1000, 1000000]. Got: ${String(value)}`,
    );
  }
  return n;
}

function requireRxivPageRange(
  firstPage: unknown,
  lastPage: unknown,
): { firstPage: number; lastPage: number } {
  const first = Number(firstPage ?? 1);
  const last = Number(lastPage ?? 20);
  if (!Number.isInteger(first) || first < 1) {
    throw new Error("rxiv first-page must be an integer >= 1.");
  }
  if (!Number.isInteger(last) || last < first) {
    throw new Error("rxiv last-page must be an integer >= first-page.");
  }
  return { firstPage: first, lastPage: last };
}

function isoDateDaysAgo(days: number): string {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

function encodeDoiPath(doi: string): string {
  return doi.split("/").map(encodeURIComponent).join("/");
}

function pdfUrl(config: RxivConfig, doi: string, version: string): string {
  return `${config.webOrigin}/content/${doi}v${version}.full.pdf`;
}

function landingUrl(config: RxivConfig, doi: string, version: string): string {
  return `${config.webOrigin}/content/${doi}v${version}`;
}

export function rxivArtifactFilename(input: {
  doi: string;
  version?: string;
  title?: unknown;
}): string {
  const slug = cleanText(input.title)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const version = input.version ? `v${input.version}` : "";
  return sanitizeFilename(
    `${input.doi}${version}${slug ? `-${slug}` : ""}.pdf`,
  );
}

export function mapRxivPreprint(
  preprint: RxivPreprint,
  config: RxivConfig,
  rank?: number,
): Record<string, unknown> {
  const doi = requireRxivDoi(preprint.doi, config.site);
  const version = stringField(preprint.version) || "1";
  const sourceUrl = landingUrl(config, doi, version);
  return {
    ...(rank === undefined ? {} : { rank }),
    id: doi,
    title: cleanText(preprint.title),
    authors: stringField(preprint.authors)
      .split(/\s*;\s*/)
      .map((author) => author.trim())
      .filter(Boolean),
    author_corresponding: cleanText(preprint.author_corresponding),
    author_corresponding_institution: cleanText(
      preprint.author_corresponding_institution,
    ),
    date: stringField(preprint.date),
    year: Number(stringField(preprint.date).slice(0, 4)) || undefined,
    version,
    type: cleanText(preprint.type),
    license: cleanText(preprint.license),
    category: cleanText(preprint.category),
    venue: config.label,
    abstract: cleanText(preprint.abstract),
    published: cleanText(preprint.published),
    server: cleanText(preprint.server) || config.label,
    doi,
    jatsxml_url: stringField(preprint.jatsxml),
    pdf_url: pdfUrl(config, doi, version),
    landing_url: sourceUrl,
    source_url: sourceUrl,
    source_adapter: config.site,
    retrieved_at: new Date().toISOString(),
    url: sourceUrl,
  };
}

function envelopeRows(envelope: RxivEnvelope): RxivPreprint[] {
  return Array.isArray(envelope.collection) ? envelope.collection : [];
}

async function fetchRxivJson(
  url: string,
  label: string,
): Promise<RxivEnvelope> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "unicli-rxiv/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
    },
  });
  if (response.status === 404) return { collection: [] };
  if (response.status === 429) throw new Error(`${label} returned HTTP 429.`);
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}.`);
  const envelope = (await response.json()) as RxivEnvelope;
  const status = stringField(envelope.messages?.[0]?.status).toLowerCase();
  if (status && status !== "ok" && status !== "no posts found") {
    throw new Error(`${label} returned status: ${status}.`);
  }
  return envelope;
}

async function fetchRxivText(url: string, label: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/xml,text/xml,*/*",
      "User-Agent": "unicli-rxiv/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
    },
  });
  if (response.status === 429) throw new Error(`${label} returned HTTP 429.`);
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}.`);
  return response.text();
}

function rowsFromEnvelope(
  envelope: RxivEnvelope,
  config: RxivConfig,
  limit: number,
): Array<Record<string, unknown>> {
  return envelopeRows(envelope)
    .slice(0, limit)
    .map((preprint, index) => mapRxivPreprint(preprint, config, index + 1));
}

function envelopeTotal(envelope: RxivEnvelope): number | undefined {
  const raw =
    envelope.messages?.[0]?.total ??
    envelope.messages?.[0]?.count ??
    envelope.collection?.length;
  const total = Number(raw);
  return Number.isFinite(total) && total >= 0 ? total : undefined;
}

function searchableText(preprint: RxivPreprint): Record<string, string> {
  return {
    title: cleanText(preprint.title),
    abstract: stripHtml(stringField(preprint.abstract)),
    authors: cleanText(preprint.authors),
    doi: bareDoi(preprint.doi),
    category: cleanText(preprint.category),
  };
}

function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}.]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

export function rxivSearchMatchedFields(
  preprint: RxivPreprint,
  queryValue: unknown,
): string[] {
  const query = requireRxivQuery(queryValue).toLowerCase();
  const tokens = queryTokens(query);
  const fields = searchableText(preprint);
  return Object.entries(fields).flatMap(([field, value]) => {
    const haystack = value.toLowerCase();
    if (!haystack) return [];
    if (haystack.includes(query)) return [field];
    return tokens.length > 0 &&
      tokens.every((token) => haystack.includes(token))
      ? [field]
      : [];
  });
}

function annotateSearchRow(
  row: Record<string, unknown>,
  input: {
    rank: number;
    matchedFields: string[];
    from: string;
    to: string;
    scannedRecords: number;
    totalRecords?: number;
    isExhaustive: boolean;
  },
): Record<string, unknown> {
  return {
    ...row,
    rank: input.rank,
    matched_fields: input.matchedFields,
    search_scope: "official_api_date_window",
    search_window: `${input.from}:${input.to}`,
    search_scanned_records: input.scannedRecords,
    search_total_records: input.totalRecords,
    search_exhaustive: input.isExhaustive,
  };
}

export async function fetchRecentRows(
  config: RxivConfig,
  kwargs: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const from = requireRxivDate(kwargs.from ?? isoDateDaysAgo(7), "from");
  const to = requireRxivDate(kwargs.to ?? isoDateDaysAgo(0), "to");
  const cursor = requireRxivCursor(kwargs.cursor);
  const limit = requireRxivLimit(kwargs.limit);
  const url = new URL(
    `${API_BASE}/${config.apiServer}/${from}/${to}/${cursor}/json`,
  );
  const category = String(kwargs.category ?? "").trim();
  if (category) url.searchParams.set("category", category);
  const rows = rowsFromEnvelope(
    await fetchRxivJson(url.toString(), `${config.label} recent`),
    config,
    limit,
  );
  if (rows.length === 0) {
    throw new Error(`No ${config.label} preprints found for ${from}:${to}.`);
  }
  return rows;
}

export async function fetchSearchRows(
  config: RxivConfig,
  kwargs: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const query = requireRxivQuery(kwargs.query ?? kwargs.q);
  const from = requireRxivDate(kwargs.from ?? isoDateDaysAgo(7), "from");
  const to = requireRxivDate(kwargs.to ?? isoDateDaysAgo(0), "to");
  const cursor = requireRxivCursor(kwargs.cursor);
  const limit = requireRxivLimit(kwargs.limit, 20);
  const maxPages = requireRxivSearchPages(
    kwargs["max-pages"] ?? kwargs.maxPages,
    10,
  );
  const category = String(kwargs.category ?? "").trim();
  const matches: Array<{
    preprint: RxivPreprint;
    matchedFields: string[];
  }> = [];
  let scannedRecords = 0;
  let totalRecords: number | undefined;
  let isExhaustive = false;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const pageCursor = cursor + pageIndex * 30;
    const url = new URL(
      `${API_BASE}/${config.apiServer}/${from}/${to}/${pageCursor}/json`,
    );
    if (category) url.searchParams.set("category", category);
    const envelope = await fetchRxivJson(
      url.toString(),
      `${config.label} search`,
    );
    const rows = envelopeRows(envelope);
    const total = envelopeTotal(envelope);
    totalRecords = totalRecords ?? total;
    scannedRecords += rows.length;

    for (const preprint of rows) {
      const matchedFields = rxivSearchMatchedFields(preprint, query);
      if (matchedFields.length > 0) matches.push({ preprint, matchedFields });
      if (matches.length >= limit) break;
    }

    const knownTotal = totalRecords ?? 0;
    isExhaustive =
      rows.length === 0 ||
      rows.length < 30 ||
      (knownTotal > 0 && pageCursor + rows.length >= knownTotal);
    if (matches.length >= limit || isExhaustive) break;
  }

  if (matches.length === 0) {
    throw new Error(
      `No ${config.label} preprints matched "${query}" in official API window ${from}:${to} after scanning ${scannedRecords} record(s).`,
    );
  }

  return matches.slice(0, limit).map(({ preprint, matchedFields }, index) =>
    annotateSearchRow(mapRxivPreprint(preprint, config), {
      rank: index + 1,
      matchedFields,
      from,
      to,
      scannedRecords,
      totalRecords,
      isExhaustive,
    }),
  );
}

export async function fetchPaperRow(
  config: RxivConfig,
  doiValue: unknown,
): Promise<Record<string, unknown>> {
  const doi = requireRxivDoi(doiValue, config.site);
  const envelope = await fetchRxivJson(
    `${API_BASE}/${config.apiServer}/${encodeDoiPath(doi)}/na/json`,
    `${config.label} paper ${doi}`,
  );
  const row = envelopeRows(envelope)[0];
  if (!row) throw new Error(`No ${config.label} preprint found for ${doi}.`);
  return mapRxivPreprint(row, config);
}

export async function downloadRxivPdf(
  config: RxivConfig,
  row: Record<string, unknown>,
  output: unknown,
): Promise<Record<string, unknown>> {
  const doi = requireRxivDoi(row.doi, config.site);
  const pdf = stringField(row.pdf_url);
  if (!pdf) throw new Error(`${config.label} preprint ${doi} has no PDF URL.`);
  const outputDir = resolve(String(output ?? "./rxiv-downloads"));
  const path = join(
    outputDir,
    rxivArtifactFilename({
      doi,
      version: stringField(row.version),
      title: row.title,
    }),
  );
  const download = await httpDownload(pdf, path, {
    headers: {
      Accept: "application/pdf,*/*",
      Referer: `${config.webOrigin}/`,
      "User-Agent": "unicli-rxiv/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
    },
  });
  if (download.status === "failed") {
    throw rxivAssetError(config, "PDF", doi, download.error ?? "unknown error");
  }
  return { ...row, path: download.path, _download: download };
}

function elements(root: Document | Element, tagName: string): Element[] {
  const nodes = root.getElementsByTagName(tagName);
  return Array.from({ length: nodes.length }, (_, index) =>
    nodes.item(index),
  ).filter((node): node is Element => node !== null);
}

function firstElement(
  root: Document | Element,
  tagName: string,
): Element | null {
  return elements(root, tagName)[0] ?? null;
}

function directChildElements(root: Element, tagName: string): Element[] {
  const out: Element[] = [];
  for (let index = 0; index < root.childNodes.length; index += 1) {
    const node = root.childNodes.item(index);
    if (node?.nodeType === 1 && node.nodeName === tagName) {
      out.push(node as Element);
    }
  }
  return out;
}

function directChildText(root: Element, tagName: string): string {
  return cleanText(directChildElements(root, tagName)[0]?.textContent ?? "");
}

function sectionText(section: Element): string {
  const title = directChildText(section, "title");
  const paragraphs = directChildElements(section, "p")
    .map((paragraph) => cleanText(paragraph.textContent ?? ""))
    .filter(Boolean);
  const nested = directChildElements(section, "sec")
    .map(sectionText)
    .filter(Boolean);
  return [title ? `## ${title}` : "", ...paragraphs, ...nested]
    .filter(Boolean)
    .join("\n\n");
}

function truncateText(
  text: string,
  maxChars: number,
): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars).trimEnd()}\n\n[truncated at ${maxChars} characters]`,
    truncated: true,
  };
}

export function mapRxivJatsFullTextRow(
  xml: string,
  row: Record<string, unknown>,
  config: RxivConfig,
  maxChars = 40_000,
): Record<string, unknown> {
  const document = new DOMParser().parseFromString(xml, "text/xml");
  const title =
    cleanText(firstElement(document, "article-title")?.textContent ?? "") ||
    cleanText(row.title);
  if (!title)
    throw new Error(`${config.label} JATS XML did not include a title.`);
  const abstract = cleanText(
    firstElement(document, "abstract")?.textContent ?? "",
  );
  const body = firstElement(document, "body");
  const bodyText = body
    ? [
        ...directChildElements(body, "p").map((paragraph) =>
          cleanText(paragraph.textContent ?? ""),
        ),
        ...directChildElements(body, "sec").map(sectionText),
      ]
        .filter(Boolean)
        .join("\n\n")
    : "";
  const text = [abstract ? `## Abstract\n\n${abstract}` : "", bodyText]
    .filter(Boolean)
    .join("\n\n");
  if (!text) {
    throw new Error(`${config.label} JATS XML did not include readable text.`);
  }
  const truncated = truncateText(text, maxChars);
  return {
    id: row.id,
    title,
    doi: row.doi,
    version: row.version,
    pdf_url: row.pdf_url,
    source_adapter: config.site,
    source_url: row.source_url,
    text: truncated.text,
    text_truncated: truncated.truncated,
    text_source: "jats_xml",
    retrieved_at: new Date().toISOString(),
  };
}

export async function readRxivPaper(
  config: RxivConfig,
  kwargs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const row = await fetchPaperRow(
    config,
    kwargs.doi ?? kwargs.id ?? kwargs.ref,
  );
  const maxChars = requireRxivMaxChars(
    kwargs["max-chars"] ?? kwargs.maxChars,
    40_000,
  );
  const jatsUrl = stringField(row.jatsxml_url);
  let jatsError = "";
  if (jatsUrl) {
    try {
      const xml = await fetchRxivText(jatsUrl, `${config.label} JATS XML`);
      return mapRxivJatsFullTextRow(xml, row, config, maxChars);
    } catch (error) {
      jatsError = error instanceof Error ? error.message : String(error);
    }
  }

  const { firstPage, lastPage } = requireRxivPageRange(
    kwargs["first-page"] ?? kwargs.firstPage,
    kwargs["last-page"] ?? kwargs.lastPage,
  );
  const downloaded = await downloadRxivPdf(config, row, kwargs.output);
  const path = stringField(downloaded.path);
  if (!path) throw new Error(`${config.label} PDF download produced no path.`);
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
      path,
      "-",
    ],
    { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
  );
  const text = stdout.trim();
  if (!text) {
    throw new Error(
      `pdftotext returned no text for ${config.label} ${downloaded.doi} pages ${firstPage}-${lastPage}.`,
    );
  }
  const truncated = truncateText(text, maxChars);
  return {
    id: downloaded.id,
    title: downloaded.title,
    doi: downloaded.doi,
    version: downloaded.version,
    pdf_url: downloaded.pdf_url,
    path,
    source_adapter: downloaded.source_adapter,
    source_url: downloaded.source_url,
    text: truncated.text,
    text_truncated: truncated.truncated,
    text_source: "pdf",
    ...(jatsError ? { jats_error: jatsError } : {}),
    retrieved_at: new Date().toISOString(),
  };
}
