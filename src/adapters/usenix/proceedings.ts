/**
 * @owner       src::adapters::usenix::proceedings
 * @does        Registers first-party USENIX conference paper, proceedings, award, metadata, and open-PDF lookup from official technical-session and presentation pages.
 * @needs       www.usenix.org public conference HTML, cheerio, stable citation meta tags
 * @feeds       src/commands/scholar.ts via scholar.search, scholar.venue, scholar.get, scholar.pdf, scholar.awards, and scholar.context
 * @breaks      USENIX event slug or HTML structure drift surfaces as structured empty-result or upstream errors.
 * @invariants  Every paper URL and PDF URL is first-party USENIX evidence; inferred PDF paths are forbidden; conference aliases resolve to an explicit event slug and year.
 * @side-effects HTTPS egress to www.usenix.org
 * @perf        Proceedings lookup fetches one schedule page per event; cross-conference search fetches at most five current-year pages concurrently.
 * @concurrency safe
 * @test        tests/unit/adapters/usenix.test.ts
 * @stability   experimental
 * @since       2026-08-09
 */

import { load } from "cheerio";

import { cli, Strategy } from "../../registry.js";
import type {
  ScholarlyContextRecord,
  ScholarlyWorkRecord,
} from "../../types/scholarly.js";

const ORIGIN = "https://www.usenix.org";
const REQUEST_TIMEOUT_MS = 15_000;
const CURRENT_YEAR = new Date().getUTCFullYear();

type UsenixSeries = "fast" | "nsdi" | "osdi" | "usenixsecurity" | "atc";

const SERIES: Record<
  UsenixSeries,
  { acronym: string; name: string; aliases: string[] }
> = {
  fast: {
    acronym: "FAST",
    name: "USENIX Conference on File and Storage Technologies",
    aliases: ["fast", "file and storage technologies"],
  },
  nsdi: {
    acronym: "NSDI",
    name: "USENIX Symposium on Networked Systems Design and Implementation",
    aliases: ["nsdi", "networked systems design and implementation"],
  },
  osdi: {
    acronym: "OSDI",
    name: "USENIX Symposium on Operating Systems Design and Implementation",
    aliases: ["osdi", "operating systems design and implementation"],
  },
  usenixsecurity: {
    acronym: "USENIX Security",
    name: "USENIX Security Symposium",
    aliases: ["usenix security", "security symposium", "security"],
  },
  atc: {
    acronym: "USENIX ATC",
    name: "USENIX Annual Technical Conference",
    aliases: [
      "usenix atc",
      "annual technical conference",
      "acm sigops atc",
      "atc",
    ],
  },
};

interface ActionableUsenixError extends Error {
  code: string;
  suggestion: string;
  retryable: boolean;
  alternatives: string[];
}

export interface UsenixSchedulePaper {
  id: string;
  title: string;
  authors?: string[];
  abstract?: string;
  award?: string;
  landing_url: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function normalized(value: unknown): string {
  return text(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function error(
  code: string,
  message: string,
  suggestion: string,
  retryable = false,
  alternatives: string[] = [],
): ActionableUsenixError {
  return Object.assign(new Error(message), {
    code,
    suggestion,
    retryable,
    alternatives,
  });
}

function boundedLimit(value: unknown, fallback: number): number {
  const limit = Number(value ?? fallback);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw error(
      "invalid_input",
      "usenix limit must be an integer in [1, 200].",
      "Choose a result limit from 1 through 200.",
    );
  }
  return limit;
}

function optionalYear(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const year = Number(value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw error(
      "invalid_input",
      "usenix year must be an integer in [2000, 2100].",
      "Choose a USENIX conference publication year from 2000 through 2100.",
    );
  }
  return year;
}

export function resolveUsenixSeries(value: unknown): UsenixSeries {
  const query = normalized(value);
  for (const [series, config] of Object.entries(SERIES) as Array<
    [UsenixSeries, (typeof SERIES)[UsenixSeries]]
  >) {
    if (
      normalized(config.acronym) === query ||
      normalized(config.name) === query ||
      config.aliases.some((alias) => normalized(alias) === query)
    ) {
      return series;
    }
  }
  throw error(
    "invalid_input",
    `unsupported USENIX conference "${text(value)}".`,
    "Use FAST, NSDI, OSDI, USENIX Security, or USENIX ATC.",
    false,
    ["unicli usenix conferences"],
  );
}

function eventSlug(series: UsenixSeries, year: number): string {
  return `${series}${String(year).slice(-2)}`;
}

function absoluteUrl(value: string): string {
  if (!value) return "";
  return new URL(value, ORIGIN).toString();
}

function authorNames(value: string): string[] | undefined {
  const withoutInstitutions = value.replace(/<em>[\s\S]*?<\/em>/gi, " ");
  const $ = load(`<div>${withoutInstitutions}</div>`);
  $("[class*='award'], [class*='badge']").remove();
  const names = $("div")
    .text()
    .replace(/\b(?:awarded\s+)?(?:best|distinguished)\s+paper!?\b/gi, " ")
    .replace(/\band\b/gi, ",")
    .split(/[;,]/)
    .map(text)
    .filter(
      (name) => Boolean(name) && !/\b(?:award|affiliation)\b/i.test(name),
    );
  return names.length > 0 ? names : undefined;
}

export function parseUsenixSchedule(html: string): UsenixSchedulePaper[] {
  const $ = load(html);
  const rows: UsenixSchedulePaper[] = [];
  $("article.node-paper").each((_index, element) => {
    const article = $(element);
    const hasOfficialPdf =
      article.find(".usenix-schedule-media.pdf").length > 0;
    if (!hasOfficialPdf) return;
    const link = article
      .find('a[href*="/presentation/"]')
      .filter((_i, anchor) => text($(anchor).text()).length > 0)
      .first();
    const title = text(link.text());
    const landingUrl = absoluteUrl(text(link.attr("href")));
    if (!title || !landingUrl) return;
    const authorHtml = article
      .find(".field-name-field-paper-people-text .field-item")
      .first()
      .html();
    const abstract = text(
      article
        .find(
          ".field-name-field-paper-description-long, .field-name-field-paper-description",
        )
        .first()
        .text(),
    );
    const awardText = text(article.text());
    const award = /awarded best paper/i.test(awardText)
      ? "Best Paper"
      : /distinguished paper/i.test(awardText)
        ? "Distinguished Paper"
        : undefined;
    rows.push({
      id: new URL(landingUrl).pathname.replace(/^\/+/, ""),
      title,
      authors: authorHtml ? authorNames(authorHtml) : undefined,
      abstract: abstract || undefined,
      award,
      landing_url: landingUrl,
    });
  });
  return rows;
}

function metaValues(html: string, name: string): string[] {
  const $ = load(html);
  return $(`meta[name="${name}"]`)
    .map((_index, element) => text($(element).attr("content")))
    .get()
    .filter(Boolean);
}

export function parseUsenixPresentation(
  html: string,
  sourceUrl: string,
): ScholarlyWorkRecord & Record<string, unknown> {
  const title = metaValues(html, "citation_title")[0] ?? "";
  const authors = metaValues(html, "citation_author");
  const year = Number(metaValues(html, "citation_publication_date")[0]);
  const venue = metaValues(html, "citation_conference_title")[0];
  const pdfUrl = metaValues(html, "citation_pdf_url")[0];
  if (!title) {
    throw error(
      "parse_error",
      "USENIX presentation page omitted citation_title metadata.",
      "Retry after the official presentation page is complete.",
    );
  }
  const $ = load(html);
  const abstract = text(
    $(".field-name-field-paper-description .field-item").first().text(),
  );
  const bodyText = text($("body").text());
  const award = /awarded best paper/i.test(bodyText)
    ? "Best Paper"
    : /distinguished paper/i.test(bodyText)
      ? "Distinguished Paper"
      : undefined;
  return {
    id: new URL(sourceUrl).pathname.replace(/^\/+/, ""),
    title,
    authors: authors.length > 0 ? authors : undefined,
    year: Number.isInteger(year) ? year : undefined,
    venue: venue || undefined,
    type: "proceedings-article",
    abstract: abstract || undefined,
    pdf_url: pdfUrl || undefined,
    landing_url: sourceUrl,
    source_adapter: "usenix",
    source_url: sourceUrl,
    retrieved_at: new Date().toISOString(),
    award,
  };
}

async function fetchHtml(url: string, label: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent":
          "unicli-usenix/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404) {
      throw error(
        "empty_result",
        `${label} returned no result.`,
        "Verify the USENIX conference and year.",
      );
    }
    if (response.status === 429) {
      throw error(
        "rate_limited",
        `${label} returned HTTP 429.`,
        "Retry after the USENIX rate-limit window.",
        true,
      );
    }
    if (!response.ok) {
      throw error(
        "upstream_error",
        `${label} returned HTTP ${response.status}.`,
        "Retry after the USENIX website is reachable and healthy.",
        response.status >= 500,
      );
    }
    return response.text();
  } catch (caught) {
    if (
      caught instanceof Error &&
      (caught.name === "TimeoutError" || caught.name === "AbortError")
    ) {
      throw error(
        "timeout",
        `${label} timed out after ${REQUEST_TIMEOUT_MS} ms.`,
        "Retry later or select another scholarly source.",
        true,
      );
    }
    throw caught;
  }
}

async function scheduleRows(
  series: UsenixSeries,
  year: number,
): Promise<Array<ScholarlyWorkRecord & Record<string, unknown>>> {
  const slug = eventSlug(series, year);
  const url = `${ORIGIN}/conference/${slug}/technical-sessions`;
  const rows = parseUsenixSchedule(
    await fetchHtml(url, `${SERIES[series].acronym} ${year} schedule`),
  );
  return rows.map((row) => ({
    ...row,
    year,
    venue: `${SERIES[series].acronym} ${year}`,
    type: "proceedings-article",
    source_adapter: "usenix",
    source_url: row.landing_url,
    retrieved_at: new Date().toISOString(),
  }));
}

function filterRows(
  rows: Array<ScholarlyWorkRecord & Record<string, unknown>>,
  query: unknown,
  limit: number,
): Array<ScholarlyWorkRecord & Record<string, unknown>> {
  const needle = normalized(query);
  return rows
    .filter((row) => {
      if (!needle) return true;
      return normalized(
        [row.title, row.authors?.join(" "), row.abstract].join(" "),
      ).includes(needle);
    })
    .slice(0, limit);
}

function noRows(label: string): never {
  throw error(
    "empty_result",
    `${label} returned no matching USENIX papers.`,
    "Verify the conference, year, and paper-title query.",
    false,
    ["unicli usenix conferences"],
  );
}

const paperColumns = [
  "id",
  "title",
  "authors",
  "year",
  "venue",
  "award",
  "pdf_url",
  "landing_url",
  "source_url",
];

cli({
  site: "usenix",
  name: "conferences",
  description: "List first-party USENIX scholarly conference series",
  domain: "www.usenix.org",
  strategy: Strategy.PUBLIC,
  args: [],
  columns: ["acronym", "title", "aliases", "source_url"],
  operation_effect: "read",
  execution_operator: "local-runtime",
  operation_family: "list",
  capabilities: [],
  func: async () =>
    Object.values(SERIES).map((series) => ({
      id: normalized(series.acronym).replace(/\s+/g, "-"),
      acronym: series.acronym,
      title: series.name,
      aliases: series.aliases,
      relation: "official-conference",
      source_adapter: "usenix",
      source_url: ORIGIN,
      retrieved_at: new Date().toISOString(),
    })) satisfies ScholarlyContextRecord[],
});

cli({
  site: "usenix",
  name: "venue",
  description: "List papers from an official USENIX conference schedule",
  domain: "www.usenix.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "venue", type: "str", required: true, positional: true },
    { name: "year", type: "int", minimum: 2000, maximum: 2100 },
    { name: "query", type: "str" },
    { name: "limit", type: "int", default: 50, minimum: 1, maximum: 200 },
  ],
  columns: paperColumns,
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "list",
  capabilities: ["http.fetch", "scholar.venue", "scholar.context"],
  func: async (_page, kwargs) => {
    const series = resolveUsenixSeries(kwargs.venue ?? kwargs.conference);
    const year = optionalYear(kwargs.year) ?? CURRENT_YEAR;
    const rows = filterRows(
      await scheduleRows(series, year),
      kwargs.query,
      boundedLimit(kwargs.limit, 50),
    );
    return rows.length > 0 ? rows : noRows(`${SERIES[series].acronym} ${year}`);
  },
});

cli({
  site: "usenix",
  name: "search",
  description: "Search current official USENIX conference schedules",
  domain: "www.usenix.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "venue", type: "str" },
    { name: "year", type: "int", minimum: 2000, maximum: 2100 },
    { name: "limit", type: "int", default: 20, minimum: 1, maximum: 200 },
  ],
  columns: paperColumns,
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "search",
  capabilities: ["http.fetch", "scholar.search"],
  func: async (_page, kwargs) => {
    const year = optionalYear(kwargs.year) ?? CURRENT_YEAR;
    const series = kwargs.venue
      ? [resolveUsenixSeries(kwargs.venue)]
      : (Object.keys(SERIES) as UsenixSeries[]).filter(
          (candidate) => candidate !== "atc" || year <= 2024,
        );
    const outcomes = await Promise.allSettled(
      series.map((candidate) => scheduleRows(candidate, year)),
    );
    const firstFailure = outcomes.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );
    if (
      firstFailure &&
      outcomes.every((outcome) => outcome.status === "rejected")
    ) {
      throw firstFailure.reason;
    }
    const combined = outcomes.flatMap((outcome) =>
      outcome.status === "fulfilled" ? outcome.value : [],
    );
    const rows = filterRows(
      combined,
      kwargs.query,
      boundedLimit(kwargs.limit, 20),
    );
    return rows.length > 0 ? rows : noRows(`USENIX ${year} search`);
  },
});

cli({
  site: "usenix",
  name: "paper",
  description:
    "Fetch one official USENIX presentation by first-party presentation URL or path",
  domain: "www.usenix.org",
  strategy: Strategy.PUBLIC,
  args: [{ name: "ref", type: "str", required: true, positional: true }],
  columns: paperColumns,
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "get",
  capabilities: ["http.fetch", "scholar.get", "scholar.pdf"],
  func: async (_page, kwargs) => {
    const ref = text(kwargs.ref ?? kwargs.id);
    let url: URL;
    try {
      url = new URL(ref, ORIGIN);
    } catch {
      throw error(
        "invalid_input",
        `invalid USENIX presentation reference "${ref}".`,
        "Pass a www.usenix.org conference presentation URL from `unicli usenix venue`.",
      );
    }
    if (
      url.hostname !== "www.usenix.org" ||
      !/^\/conference\/[^/]+\/presentation\/[^/]+\/?$/.test(url.pathname)
    ) {
      throw error(
        "invalid_input",
        `USENIX paper reference "${ref}" is not a presentation URL.`,
        "Pass a www.usenix.org conference presentation URL from `unicli usenix venue`.",
      );
    }
    const sourceUrl = url.toString();
    return [
      parseUsenixPresentation(
        await fetchHtml(sourceUrl, "USENIX presentation"),
        sourceUrl,
      ),
    ];
  },
});

cli({
  site: "usenix",
  name: "awards",
  description: "List award-marked papers from an official USENIX schedule",
  domain: "www.usenix.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "venue", type: "str", required: true, positional: true },
    { name: "year", type: "int", minimum: 2000, maximum: 2100 },
    { name: "query", type: "str" },
    { name: "limit", type: "int", default: 50, minimum: 1, maximum: 200 },
  ],
  columns: paperColumns,
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "list",
  capabilities: ["http.fetch", "scholar.awards", "scholar.context"],
  func: async (_page, kwargs) => {
    const series = resolveUsenixSeries(kwargs.venue ?? kwargs.conference);
    const year = optionalYear(kwargs.year) ?? CURRENT_YEAR;
    const rows = filterRows(
      (await scheduleRows(series, year)).filter((row) => row.award),
      kwargs.query,
      boundedLimit(kwargs.limit, 50),
    );
    return rows.length > 0
      ? rows
      : noRows(`${SERIES[series].acronym} ${year} awards`);
  },
});
