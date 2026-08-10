/**
 * @owner       src::adapters::aaai::proceedings
 * @does        Registers AAAI main Technical Tracks paper listing, search, and detail lookup from the official OJS proceedings HTML.
 * @needs       ojs.aaai.org public archive, issue, article, and PDF-galley HTML links; cheerio; src/registry.ts
 * @feeds       Direct AAAI commands and scholarly routing via scholar.search, scholar.venue, scholar.get, and scholar.pdf
 * @breaks      OJS archive pagination or markup drift surfaces as structured parse, empty-result, timeout, rate-limit, or upstream errors.
 * @invariants  Year listings include only issues titled AAAI-YY Technical Tracks N; DOI and PDF fields are copied from official OJS HTML and are never inferred.
 * @side-effects HTTPS egress to ojs.aaai.org
 * @perf        O(archive pages + Technical Track issue pages + returned detail pages), with six bounded concurrent requests
 * @concurrency safe
 * @test        tests/unit/adapters/aaai.test.ts
 * @stability   experimental
 * @since       2026-08-09
 */

import { load } from "cheerio";

import { cli, Strategy } from "../../registry.js";
import type { ScholarlyWorkRecord } from "../../types/scholarly.js";

const ORIGIN = "https://ojs.aaai.org";
const ARCHIVE_URL = `${ORIGIN}/index.php/AAAI/issue/archive`;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ARCHIVE_PAGES = 10;
const FETCH_CONCURRENCY = 6;
const CURRENT_YEAR = new Date().getUTCFullYear();

interface ActionableAaaiError extends Error {
  code: string;
  suggestion: string;
  retryable: boolean;
  alternatives: string[];
}

export interface AaaiArchiveIssue {
  id: string;
  title: string;
  year?: number;
  track_number?: number;
  volume?: number;
  issue?: number;
  track?: string;
  source_url: string;
  is_technical_track: boolean;
}

export type AaaiPaperRecord = ScholarlyWorkRecord & {
  landing_url: string;
  source_url: string;
  pages?: string;
  track?: string;
  issue_id?: string;
  issue_title?: string;
  volume?: string;
  issue?: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function normalized(value: unknown): string {
  return text(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function absoluteUrl(value: unknown): string {
  const url = text(value);
  return url ? new URL(url, ORIGIN).toString() : "";
}

function error(
  code: string,
  message: string,
  suggestion: string,
  retryable = false,
  alternatives: string[] = [],
): ActionableAaaiError {
  return Object.assign(new Error(message), {
    code,
    suggestion,
    retryable,
    alternatives,
  });
}

function requiredYear(value: unknown): number {
  const year = Number(value ?? CURRENT_YEAR);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    throw error(
      "invalid_input",
      "aaai year must be an integer in [2020, 2100].",
      "Choose an AAAI Technical Tracks publication year from 2020 through 2100.",
    );
  }
  return year;
}

function boundedLimit(value: unknown, fallback: number): number {
  const limit = Number(value ?? fallback);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw error(
      "invalid_input",
      "aaai limit must be an integer in [1, 100].",
      "Choose a result limit from 1 through 100.",
    );
  }
  return limit;
}

function requireAaaiVenue(value: unknown): void {
  const venue = normalized(value || "AAAI");
  if (
    venue !== "aaai" &&
    venue !== "aaai conference on artificial intelligence" &&
    venue !== "proceedings of the aaai conference on artificial intelligence"
  ) {
    throw error(
      "invalid_input",
      `aaai papers does not cover venue "${text(value)}".`,
      "Use AAAI or AAAI Conference on Artificial Intelligence.",
    );
  }
}

function twoDigitYear(value: string): number | undefined {
  const match = value.match(/\bAAAI-(\d{2})\b/i);
  return match ? 2000 + Number(match[1]) : undefined;
}

function technicalTrackIdentity(
  value: string,
): { year: number; trackNumber: number } | undefined {
  const match = value.match(/^AAAI-(\d{2}) Technical Tracks? (\d+)$/i);
  if (!match) return undefined;
  return {
    year: 2000 + Number(match[1]),
    trackNumber: Number(match[2]),
  };
}

function optionalInteger(value: string): string | undefined {
  const number = Number(value);
  return Number.isInteger(number) ? String(number) : undefined;
}

function metaValues(html: string, name: string): string[] {
  const $ = load(html);
  return $(`meta[name="${name}"]`)
    .map((_index, element) => text($(element).attr("content")))
    .get()
    .filter(Boolean);
}

function firstMetaValue(html: string, names: string[]): string {
  for (const name of names) {
    const value = metaValues(html, name)[0];
    if (value) return value;
  }
  return "";
}

export function parseAaaiArchivePage(html: string): AaaiArchiveIssue[] {
  const $ = load(html);
  const issues: AaaiArchiveIssue[] = [];
  $(".obj_issue_summary").each((_index, element) => {
    const summary = $(element);
    const link = summary.find("a.title").first();
    const title = text(link.text());
    const sourceUrl = absoluteUrl(link.attr("href"));
    const id = sourceUrl.match(/\/issue\/view\/(\d+)/)?.[1] ?? "";
    if (!title || !sourceUrl || !id) return;
    const identity = technicalTrackIdentity(title);
    const series = text(summary.find(".series").first().text());
    const seriesMatch = series.match(/Vol\.\s*(\d+)\s+No\.\s*(\d+)/i);
    const descriptionParagraphs = summary
      .find(".description p")
      .map((_paragraphIndex, paragraph) => text($(paragraph).text()))
      .get()
      .filter(Boolean);
    const track = descriptionParagraphs.find((paragraph) =>
      /^AAAI Technical Track\b/i.test(paragraph),
    );
    issues.push({
      id,
      title,
      year: identity?.year ?? twoDigitYear(title),
      track_number: identity?.trackNumber,
      volume: seriesMatch ? Number(seriesMatch[1]) : undefined,
      issue: seriesMatch ? Number(seriesMatch[2]) : undefined,
      track,
      source_url: sourceUrl,
      is_technical_track: identity !== undefined,
    });
  });
  return issues;
}

function articleId(value: unknown): string {
  const raw = text(value);
  const id =
    raw.match(/\/article\/(?:view|download)\/(\d+)/i)?.[1] ??
    raw.match(/^10\.1609\/aaai\.v\d+i\d+\.(\d+)$/i)?.[1] ??
    (/^\d+$/.test(raw) ? raw : "");
  if (!id) {
    throw error(
      "invalid_input",
      `AAAI paper identifier "${raw}" is not valid.`,
      "Use an OJS article id, AAAI article URL, or DOI such as 10.1609/aaai.v39i1.12345.",
    );
  }
  return id;
}

function articleUrl(id: string): string {
  return `${ORIGIN}/index.php/AAAI/article/view/${id}`;
}

export function parseAaaiIssuePage(
  html: string,
  archiveIssue: AaaiArchiveIssue,
): AaaiPaperRecord[] {
  if (!archiveIssue.is_technical_track) return [];
  const $ = load(html);
  const rows: AaaiPaperRecord[] = [];
  $(".sections .section").each((_sectionIndex, sectionElement) => {
    const section = $(sectionElement);
    const track = text(section.find("h2").first().text()) || archiveIssue.track;
    if (!/^AAAI Technical Track\b/i.test(track ?? "")) return;
    section
      .find(".obj_article_summary")
      .each((_articleIndex, articleElement) => {
        const article = $(articleElement);
        const link = article.find('.title a[href*="/article/view/"]').first();
        const title = text(link.text());
        const landingUrl = absoluteUrl(link.attr("href"));
        const id = landingUrl.match(/\/article\/view\/(\d+)/)?.[1] ?? "";
        if (!title || !landingUrl || !id) return;
        const authors = text(article.find(".authors").first().text())
          .split(/\s*,\s*/)
          .map((author) => author.trim())
          .filter(Boolean);
        const officialPdfLink = article
          .find("a.obj_galley_link.pdf[href]")
          .first()
          .attr("href");
        rows.push({
          id,
          title,
          authors: authors.length > 0 ? authors : undefined,
          year: archiveIssue.year,
          venue: archiveIssue.year ? `AAAI ${archiveIssue.year}` : "AAAI",
          type: "proceedings-article",
          pdf_url: officialPdfLink ? absoluteUrl(officialPdfLink) : undefined,
          landing_url: landingUrl,
          source_adapter: "aaai",
          source_url: landingUrl,
          retrieved_at: new Date().toISOString(),
          pages: text(article.find(".pages").first().text()) || undefined,
          track,
          issue_id: archiveIssue.id,
          issue_title: archiveIssue.title,
          volume:
            archiveIssue.volume === undefined
              ? undefined
              : String(archiveIssue.volume),
          issue:
            archiveIssue.issue === undefined
              ? undefined
              : String(archiveIssue.issue),
        });
      });
  });
  return rows;
}

export function parseAaaiPaperPage(
  html: string,
  sourceUrl: string,
): AaaiPaperRecord {
  const track = firstMetaValue(html, ["DC.Type.articleType"]);
  if (!/^AAAI Technical Track\b/i.test(track)) {
    throw error(
      "empty_result",
      "AAAI article is outside the main Technical Tracks proceedings.",
      "Choose a paper from an issue titled AAAI-YY Technical Tracks N.",
    );
  }
  const title = firstMetaValue(html, ["citation_title", "DC.Title"]);
  if (!title) {
    throw error(
      "parse_error",
      "AAAI article page omitted its official title metadata.",
      "Retry after the official OJS article metadata is available.",
      true,
    );
  }
  const $ = load(html);
  const id =
    firstMetaValue(html, ["DC.Identifier"]) ||
    sourceUrl.match(/\/article\/view\/(\d+)/)?.[1] ||
    "";
  if (!/^\d+$/.test(id)) {
    throw error(
      "parse_error",
      "AAAI article page omitted its numeric OJS identifier.",
      "Retry after the official OJS article metadata is available.",
      true,
    );
  }
  const date = firstMetaValue(html, [
    "citation_date",
    "DC.Date.issued",
    "DC.Date.created",
  ]).replaceAll("/", "-");
  const yearText = date.match(/\b(20\d{2})\b/)?.[1];
  const authors = metaValues(html, "citation_author");
  const doi = firstMetaValue(html, ["citation_doi", "DC.Identifier.DOI"]);
  const officialPdf =
    firstMetaValue(html, ["citation_pdf_url"]) ||
    absoluteUrl($("a.obj_galley_link.pdf[href]").first().attr("href"));
  const volume = optionalInteger(firstMetaValue(html, ["citation_volume"]));
  const issue = optionalInteger(firstMetaValue(html, ["citation_issue"]));
  const firstPage = firstMetaValue(html, ["citation_firstpage"]);
  const lastPage = firstMetaValue(html, ["citation_lastpage"]);
  const pages =
    firstPage && lastPage
      ? `${firstPage}-${lastPage}`
      : firstMetaValue(html, ["DC.Identifier.pageNumber"]);
  return {
    id,
    title,
    authors: authors.length > 0 ? authors : undefined,
    year: yearText ? Number(yearText) : undefined,
    date: date || undefined,
    venue:
      firstMetaValue(html, ["citation_journal_title", "DC.Source"]) ||
      "Proceedings of the AAAI Conference on Artificial Intelligence",
    type: "proceedings-article",
    doi: doi || undefined,
    abstract: firstMetaValue(html, ["DC.Description"]) || undefined,
    pdf_url: officialPdf || undefined,
    landing_url: sourceUrl,
    source_adapter: "aaai",
    source_url: sourceUrl,
    retrieved_at: new Date().toISOString(),
    pages: pages || undefined,
    track,
    volume,
    issue,
  };
}

export async function fetchAaaiHtml(
  url: string,
  label: string,
): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "unicli-aaai/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404) {
      throw error(
        "empty_result",
        `${label} returned no result.`,
        "Verify the AAAI year or OJS article identifier.",
      );
    }
    if (response.status === 429) {
      throw error(
        "rate_limited",
        `${label} returned HTTP 429.`,
        "Retry after the AAAI OJS rate-limit window.",
        true,
      );
    }
    if (!response.ok) {
      throw error(
        "upstream_error",
        `${label} returned HTTP ${response.status}.`,
        "Retry after the official AAAI OJS website is reachable and healthy.",
        response.status >= 500,
      );
    }
    return response.text();
  } catch (caught) {
    if (
      caught instanceof Error &&
      "suggestion" in caught &&
      "retryable" in caught &&
      "alternatives" in caught
    ) {
      throw caught;
    }
    if (
      caught instanceof Error &&
      (caught.name === "TimeoutError" || caught.name === "AbortError")
    ) {
      throw error(
        "timeout",
        `${label} timed out after ${REQUEST_TIMEOUT_MS} ms.`,
        "Retry later or choose another scholarly source.",
        true,
      );
    }
    throw error(
      "upstream_error",
      `${label} failed: ${caught instanceof Error ? caught.message : String(caught)}.`,
      "Retry after the official AAAI OJS website is reachable and healthy.",
      true,
    );
  }
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: values.length });
  let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(values[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () =>
      worker(),
    ),
  );
  return results;
}

async function discoverTechnicalTrackIssues(
  year: number,
): Promise<AaaiArchiveIssue[]> {
  const matches: AaaiArchiveIssue[] = [];
  for (let page = 1; page <= MAX_ARCHIVE_PAGES; page += 1) {
    const url = page === 1 ? ARCHIVE_URL : `${ARCHIVE_URL}/${page}`;
    const entries = parseAaaiArchivePage(
      await fetchAaaiHtml(url, `AAAI archive page ${page}`),
    );
    if (entries.length === 0) break;
    matches.push(
      ...entries.filter(
        (entry) => entry.is_technical_track && entry.year === year,
      ),
    );
    const years = entries
      .map((entry) => entry.year)
      .filter((value): value is number => value !== undefined);
    if (matches.length > 0 && years.some((entryYear) => entryYear < year)) {
      break;
    }
    if (matches.length === 0 && years.every((entryYear) => entryYear < year)) {
      break;
    }
  }
  const unique = new Map(matches.map((issue) => [issue.id, issue]));
  const issues = [...unique.values()].sort(
    (left, right) =>
      (left.track_number ?? Number.MAX_SAFE_INTEGER) -
      (right.track_number ?? Number.MAX_SAFE_INTEGER),
  );
  if (issues.length === 0) {
    throw error(
      "empty_result",
      `AAAI ${year} has no official Technical Tracks issues in the OJS archive.`,
      "Verify the publication year on the official AAAI proceedings archive.",
      false,
      ['unicli crossref search "AAAI Conference on Artificial Intelligence"'],
    );
  }
  return issues;
}

async function listTechnicalTrackRows(
  year: number,
  minimumRows?: number,
): Promise<AaaiPaperRecord[]> {
  const issues = await discoverTechnicalTrackIssues(year);
  const rows: AaaiPaperRecord[] = [];
  for (let index = 0; index < issues.length; index += FETCH_CONCURRENCY) {
    const batch = issues.slice(index, index + FETCH_CONCURRENCY);
    const issueRows = await mapConcurrent(
      batch,
      FETCH_CONCURRENCY,
      async (issue) =>
        parseAaaiIssuePage(
          await fetchAaaiHtml(issue.source_url, issue.title),
          issue,
        ),
    );
    rows.push(...issueRows.flat());
    if (minimumRows !== undefined && rows.length >= minimumRows) break;
  }
  if (rows.length === 0) {
    throw error(
      "parse_error",
      `AAAI ${year} Technical Tracks issues exposed no paper rows.`,
      "Retry after the official OJS issue pages are complete, or inspect their article-list markup.",
      true,
    );
  }
  return rows;
}

async function hydrateRows(
  rows: AaaiPaperRecord[],
): Promise<AaaiPaperRecord[]> {
  return mapConcurrent(rows, FETCH_CONCURRENCY, async (row) => {
    const detail = parseAaaiPaperPage(
      await fetchAaaiHtml(row.source_url, `AAAI paper ${row.id}`),
      row.source_url,
    );
    return {
      ...row,
      ...detail,
      track: detail.track ?? row.track,
      issue_id: row.issue_id,
      issue_title: row.issue_title,
      volume: detail.volume ?? row.volume,
      issue: detail.issue ?? row.issue,
    };
  });
}

function searchRows(
  rows: AaaiPaperRecord[],
  query: unknown,
): AaaiPaperRecord[] {
  const terms = normalized(query).split(" ").filter(Boolean);
  if (terms.length === 0) {
    throw error(
      "invalid_input",
      "aaai search query cannot be empty.",
      "Provide paper-title, author, or Technical Track keywords.",
    );
  }
  return rows.filter((row) => {
    const haystack = normalized(
      [row.title, row.authors?.join(" "), row.track].join(" "),
    );
    return terms.every((term) => haystack.includes(term));
  });
}

const PAPER_COLUMNS = [
  "id",
  "title",
  "authors",
  "year",
  "venue",
  "track",
  "pages",
  "doi",
  "pdf_url",
  "source_url",
];

cli({
  site: "aaai",
  name: "papers",
  description: "List official AAAI main Technical Tracks papers by year",
  domain: "ojs.aaai.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "venue", type: "str", default: "AAAI" },
    {
      name: "year",
      type: "int",
      default: CURRENT_YEAR,
      minimum: 2020,
      maximum: 2100,
    },
    { name: "limit", type: "int", default: 20, minimum: 1, maximum: 100 },
  ],
  columns: PAPER_COLUMNS,
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "list",
  capabilities: [
    "http.fetch",
    "scholar.search",
    "scholar.venue",
    "scholar.pdf",
  ],
  func: async (_page, kwargs) => {
    requireAaaiVenue(kwargs.venue);
    const year = requiredYear(kwargs.year);
    const limit = boundedLimit(kwargs.limit, 20);
    return hydrateRows(
      (await listTechnicalTrackRows(year, limit)).slice(0, limit),
    );
  },
});

cli({
  site: "aaai",
  name: "search",
  description: "Search official AAAI main Technical Tracks papers by year",
  domain: "ojs.aaai.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    {
      name: "year",
      type: "int",
      default: CURRENT_YEAR,
      minimum: 2020,
      maximum: 2100,
    },
    { name: "limit", type: "int", default: 20, minimum: 1, maximum: 100 },
  ],
  columns: PAPER_COLUMNS,
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "search",
  retrieval: {
    operation: "discover",
    result_kind: "paper",
    source_class: "official",
    arguments: { query: "query", limit: "limit" },
  },
  capabilities: ["http.fetch", "scholar.search", "scholar.pdf"],
  func: async (_page, kwargs) => {
    const year = requiredYear(kwargs.year);
    const limit = boundedLimit(kwargs.limit, 20);
    const rows = searchRows(
      await listTechnicalTrackRows(year),
      kwargs.query,
    ).slice(0, limit);
    if (rows.length === 0) {
      throw error(
        "empty_result",
        `No AAAI ${year} main Technical Tracks papers matched "${text(kwargs.query)}".`,
        "Try fewer title or author keywords while keeping the publication year exact.",
      );
    }
    return hydrateRows(rows);
  },
});

cli({
  site: "aaai",
  name: "paper",
  description:
    "Fetch one official AAAI main Technical Tracks paper by OJS id, article URL, or DOI",
  domain: "ojs.aaai.org",
  strategy: Strategy.PUBLIC,
  args: [{ name: "id", type: "str", required: true, positional: true }],
  columns: [...PAPER_COLUMNS, "abstract", "volume", "issue"],
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "get",
  capabilities: ["http.fetch", "scholar.get", "scholar.pdf"],
  func: async (_page, kwargs) => {
    const id = articleId(kwargs.id ?? kwargs.ref ?? kwargs.doi);
    const url = articleUrl(id);
    return [
      parseAaaiPaperPage(await fetchAaaiHtml(url, `AAAI paper ${id}`), url),
    ];
  },
});
