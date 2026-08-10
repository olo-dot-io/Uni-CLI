/**
 * @owner       src::adapters::pacmpl::works
 * @does        Searches and retrieves PACMPL papers by conference issue, year, title, and DOI while presenting OOPSLA1 and OOPSLA2 as one OOPSLA venue.
 * @needs       Crossref journal 2475-1421 metadata, src/adapters/_shared/crossref.ts, src/registry.ts
 * @feeds       src/commands/scholar.ts through scholar.search, scholar.venue, scholar.get, and scholar.pdf capabilities
 * @breaks      Missing PACMPL issue metadata or Crossref journal drift prevents conference attribution and surfaces an explicit empty result.
 * @invariants  Only recognised PACMPL issues are returned; OOPSLA merges legacy OOPSLA with OOPSLA1 and OOPSLA2; PDF URLs are copied only from explicit Crossref links.
 * @side-effects HTTPS egress to api.crossref.org only
 * @perf        O(issue-count * limit) mapping and local relevance ranking after at most three Crossref requests
 * @concurrency safe
 * @test        tests/unit/adapters/pacmpl.test.ts
 * @stability   experimental
 * @since       2026-08-09
 */

import { cli, Strategy } from "../../registry.js";
import type { ScholarlyWorkRecord } from "../../types/scholarly.js";
import {
  crossrefEmptyResult,
  fetchCrossref,
  mapCrossrefItem,
  requireCrossrefPrefixDoi,
  type CrossrefItem,
} from "../_shared/crossref.js";

const PACMPL_ISSN = "2475-1421";
const PACMPL_CONTAINER = "Proceedings of the ACM on Programming Languages";
const ACM_DOI_PREFIX = "10.1145";
const PACMPL_FIRST_YEAR = 2017;
const OOPSLA_SPLIT_FIRST_YEAR = 2022;

export type PacmplConference = "OOPSLA" | "POPL" | "PLDI" | "ICFP";
export type PacmplIssue =
  | "OOPSLA"
  | "OOPSLA1"
  | "OOPSLA2"
  | "POPL"
  | "PLDI"
  | "ICFP";

export interface PacmplVenueSelection {
  conference: PacmplConference;
  issues: PacmplIssue[];
}

export interface PacmplCrossrefItem extends CrossrefItem {
  issue?: unknown;
  volume?: unknown;
  ISSN?: unknown[];
}

interface PacmplWorksResponse {
  message?: { items?: PacmplCrossrefItem[] };
}

interface PacmplWorkResponse {
  message?: PacmplCrossrefItem;
}

export interface PacmplWorkRecord extends ScholarlyWorkRecord {
  conference: PacmplConference;
  issue: PacmplIssue;
  volume?: string;
}

interface PacmplActionableError extends Error {
  code: string;
  suggestion: string;
  retryable: boolean;
  alternatives: string[];
}

function pacmplError(
  code: string,
  message: string,
  suggestion: string,
  alternatives: string[] = [],
): PacmplActionableError {
  return Object.assign(new Error(message), {
    code,
    suggestion,
    retryable: false,
    alternatives,
  });
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstText(value: unknown): string {
  return Array.isArray(value) ? text(value[0]) : text(value);
}

function normalize(value: unknown): string {
  return text(value)
    .normalize("NFKD")
    .replace(/&/g, " and ")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function compact(value: unknown): string {
  return normalize(value).replace(/\s+/g, "");
}

export function resolvePacmplVenue(value: unknown): PacmplVenueSelection {
  const normalized = normalize(value);
  const compacted = compact(value);

  if (
    compacted === "OOPSLA" ||
    normalized.includes(
      "OBJECT ORIENTED PROGRAMMING SYSTEMS LANGUAGES AND APPLICATIONS",
    )
  ) {
    return {
      conference: "OOPSLA",
      issues: ["OOPSLA", "OOPSLA1", "OOPSLA2"],
    };
  }
  if (compacted === "OOPSLA1") {
    return { conference: "OOPSLA", issues: ["OOPSLA1"] };
  }
  if (compacted === "OOPSLA2") {
    return { conference: "OOPSLA", issues: ["OOPSLA2"] };
  }
  if (
    compacted === "POPL" ||
    normalized.includes("PRINCIPLES OF PROGRAMMING LANGUAGES")
  ) {
    return { conference: "POPL", issues: ["POPL"] };
  }
  if (
    compacted === "PLDI" ||
    normalized.includes("PROGRAMMING LANGUAGE DESIGN AND IMPLEMENTATION")
  ) {
    return { conference: "PLDI", issues: ["PLDI"] };
  }
  if (
    compacted === "ICFP" ||
    normalized.includes("INTERNATIONAL CONFERENCE ON FUNCTIONAL PROGRAMMING")
  ) {
    return { conference: "ICFP", issues: ["ICFP"] };
  }

  throw pacmplError(
    "invalid_input",
    `PACMPL venue "${text(value)}" is not supported.`,
    "Use OOPSLA, OOPSLA1, OOPSLA2, POPL, PLDI, or ICFP.",
    ["unicli pacmpl venue OOPSLA --year 2024"],
  );
}

function pacmplIssue(value: unknown): PacmplIssue | undefined {
  const issue = compact(value);
  return ["OOPSLA", "OOPSLA1", "OOPSLA2", "POPL", "PLDI", "ICFP"].includes(
    issue,
  )
    ? (issue as PacmplIssue)
    : undefined;
}

function conferenceForIssue(issue: PacmplIssue): PacmplConference {
  if (issue === "OOPSLA" || issue === "OOPSLA1" || issue === "OOPSLA2") {
    return "OOPSLA";
  }
  return issue;
}

function isPacmplContainer(item: PacmplCrossrefItem): boolean {
  const containers = Array.isArray(item["container-title"])
    ? item["container-title"]
    : [];
  const issns = Array.isArray(item.ISSN) ? item.ISSN.map(text) : [];
  return (
    issns.includes(PACMPL_ISSN) ||
    containers.some(
      (container) => normalize(container) === normalize(PACMPL_CONTAINER),
    )
  );
}

function explicitPdfUrl(item: PacmplCrossrefItem): string | undefined {
  if (!Array.isArray(item.link)) return undefined;
  for (const link of item.link) {
    const url = text(link.URL);
    const contentType = text(link["content-type"]).toLowerCase();
    if (
      url &&
      (contentType === "application/pdf" ||
        /(?:\/doi\/pdf\/|\.pdf(?:$|[?#]))/i.test(url))
    ) {
      return url;
    }
  }
  return undefined;
}

function rawRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function mapPacmplItem(item: PacmplCrossrefItem): PacmplWorkRecord {
  const issue = pacmplIssue(item.issue);
  if (!issue || !isPacmplContainer(item)) {
    throw crossrefEmptyResult(
      `Crossref work ${text(item.DOI) || "without DOI"} is not a supported PACMPL conference issue.`,
      ["unicli acm paper <doi>", "unicli crossref work <doi>"],
    );
  }

  const base = mapCrossrefItem(item, "pacmpl");
  const conference = conferenceForIssue(issue);
  const volume = text(item.volume) || undefined;
  return {
    ...base,
    venue: base.year ? `${conference} ${base.year}` : conference,
    conference,
    issue,
    volume,
    pdf_url: explicitPdfUrl(item),
    raw: {
      ...rawRecord(base.raw),
      container_title: firstText(item["container-title"]) || undefined,
      issn: Array.isArray(item.ISSN)
        ? item.ISSN.map(text).filter(Boolean)
        : undefined,
      issue,
      volume,
      pacmpl_conference: conference,
    },
  };
}

export function matchesPacmplSelection(
  row: PacmplWorkRecord,
  selection: PacmplVenueSelection | undefined,
  year: number | undefined,
): boolean {
  return (
    (selection === undefined || selection.issues.includes(row.issue)) &&
    (year === undefined || row.year === year)
  );
}

export function pacmplIssuesForYear(
  selection: PacmplVenueSelection,
  year: number | undefined,
): PacmplIssue[] {
  const isCombinedOopsla =
    selection.conference === "OOPSLA" && selection.issues.length === 3;
  if (!isCombinedOopsla || year === undefined) return selection.issues;
  return year < OOPSLA_SPLIT_FIRST_YEAR ? ["OOPSLA"] : ["OOPSLA1", "OOPSLA2"];
}

export function mergePacmplIssueRows(
  groups: PacmplWorkRecord[][],
  resultLimit: number,
): PacmplWorkRecord[] {
  const rows: PacmplWorkRecord[] = [];
  const seen = new Set<string>();
  const maxLength = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < maxLength && rows.length < resultLimit; index++) {
    for (const group of groups) {
      const row = group[index];
      if (!row || seen.has(row.doi ?? row.id)) continue;
      seen.add(row.doi ?? row.id);
      rows.push(row);
      if (rows.length >= resultLimit) break;
    }
  }
  return rows;
}

function relevanceScore(row: PacmplWorkRecord, query: string): number {
  const normalizedTitle = normalize(row.title);
  const normalizedQuery = normalize(query);
  if (!normalizedTitle || !normalizedQuery) return 0;
  if (normalizedTitle === normalizedQuery) return 10_000;
  if (normalizedTitle.includes(normalizedQuery)) return 5_000;
  const queryWords = normalizedQuery.split(" ").filter(Boolean);
  const titleWords = new Set(normalizedTitle.split(" ").filter(Boolean));
  return queryWords.reduce(
    (score, word) => score + (titleWords.has(word) ? 100 : 0),
    0,
  );
}

export function rankPacmplRows(
  rows: PacmplWorkRecord[],
  query: string,
  resultLimit: number,
): PacmplWorkRecord[] {
  return rows
    .map((row, index) => ({ row, index, score: relevanceScore(row, query) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, resultLimit)
    .map(({ row }) => row);
}

function optionalYear(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const year = Number(value);
  if (!Number.isInteger(year) || year < PACMPL_FIRST_YEAR || year > 2100) {
    throw pacmplError(
      "invalid_input",
      `PACMPL year must be an integer in [${PACMPL_FIRST_YEAR}, 2100].`,
      `Use a PACMPL publication year beginning with ${PACMPL_FIRST_YEAR}.`,
    );
  }
  return year;
}

function requireText(value: unknown, label: string): string {
  const result = text(value);
  if (!result) {
    throw pacmplError(
      "invalid_input",
      `PACMPL ${label} cannot be empty.`,
      `Provide a non-empty ${label}.`,
    );
  }
  return result;
}

function requireLimit(value: unknown): number {
  const result = Number(value ?? 20);
  if (!Number.isInteger(result) || result < 1 || result > 100) {
    throw pacmplError(
      "invalid_input",
      "PACMPL limit must be an integer in [1, 100].",
      "Choose a result limit from 1 through 100.",
    );
  }
  return result;
}

function worksPath(options: {
  query?: string;
  issue?: PacmplIssue;
  year?: number;
  limit: number;
}): string {
  const params = new URLSearchParams({ rows: String(options.limit) });
  const bibliographic = [options.issue, options.query]
    .filter(Boolean)
    .join(" ");
  if (bibliographic) params.set("query.bibliographic", bibliographic);
  const filters = ["type:journal-article"];
  if (options.year !== undefined) {
    filters.push(`from-pub-date:${options.year}-01-01`);
    filters.push(`until-pub-date:${options.year}-12-31`);
  }
  params.set("filter", filters.join(","));
  const mailto = process.env.CROSSREF_MAILTO?.trim();
  if (mailto) params.set("mailto", mailto);
  return `/journals/${PACMPL_ISSN}/works?${params.toString()}`;
}

async function fetchPacmplRows(options: {
  query?: string;
  issue?: PacmplIssue;
  year?: number;
  limit: number;
}): Promise<PacmplWorkRecord[]> {
  const body = (await fetchCrossref(
    worksPath(options),
    `PACMPL${options.issue ? ` ${options.issue}` : ""} search`,
  )) as PacmplWorksResponse;
  const rows: PacmplWorkRecord[] = [];
  for (const item of body.message?.items ?? []) {
    const issue = pacmplIssue(item.issue);
    if (!issue || !isPacmplContainer(item)) continue;
    if (options.issue !== undefined && issue !== options.issue) continue;
    const row = mapPacmplItem(item);
    if (options.year !== undefined && row.year !== options.year) continue;
    rows.push(row);
  }
  return rows;
}

async function queryPacmpl(options: {
  query?: string;
  selection?: PacmplVenueSelection;
  year?: number;
  limit: number;
}): Promise<PacmplWorkRecord[]> {
  if (!options.selection) {
    const rows = await fetchPacmplRows({
      query: options.query,
      year: options.year,
      limit: Math.min(options.limit * 5, 500),
    });
    const selected = rows.filter((row) =>
      matchesPacmplSelection(row, undefined, options.year),
    );
    return options.query
      ? rankPacmplRows(selected, options.query, options.limit)
      : selected.slice(0, options.limit);
  }

  const groups = await Promise.all(
    pacmplIssuesForYear(options.selection, options.year).map((issue) =>
      fetchPacmplRows({
        query: options.query,
        issue,
        year: options.year,
        limit: options.limit,
      }),
    ),
  );
  const merged = mergePacmplIssueRows(groups, options.limit * groups.length);
  return options.query
    ? rankPacmplRows(merged, options.query, options.limit)
    : mergePacmplIssueRows(groups, options.limit);
}

const PACMPL_COLUMNS = [
  "id",
  "title",
  "authors",
  "year",
  "venue",
  "conference",
  "issue",
  "volume",
  "doi",
  "pdf_url",
  "source_url",
];

cli({
  site: "pacmpl",
  name: "search",
  description:
    "Search PACMPL papers by title with optional conference issue and year filters",
  domain: "api.crossref.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "venue", type: "str" },
    {
      name: "year",
      type: "int",
      minimum: PACMPL_FIRST_YEAR,
      maximum: 2100,
    },
    { name: "limit", type: "int", default: 20, minimum: 1, maximum: 100 },
  ],
  columns: PACMPL_COLUMNS,
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "search",
  retrieval: {
    operation: "discover",
    result_kind: "paper",
    source_class: "official",
    arguments: { query: "query", limit: "limit" },
  },
  capabilities: ["http.fetch", "scholar.search"],
  func: async (_page, kwargs) => {
    const query = requireText(kwargs.query, "search query");
    const venue = text(kwargs.venue);
    const rows = await queryPacmpl({
      query,
      selection: venue ? resolvePacmplVenue(venue) : undefined,
      year: optionalYear(kwargs.year),
      limit: requireLimit(kwargs.limit),
    });
    if (rows.length === 0) {
      throw crossrefEmptyResult(`No PACMPL papers matched "${query}".`, [
        `unicli acm search ${JSON.stringify(query)}`,
        `unicli crossref search ${JSON.stringify(query)}`,
      ]);
    }
    return rows;
  },
});

cli({
  site: "pacmpl",
  name: "venue",
  description:
    "List PACMPL papers for OOPSLA, POPL, PLDI, or ICFP by publication year",
  domain: "api.crossref.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "venue", type: "str", required: true, positional: true },
    {
      name: "year",
      type: "int",
      minimum: PACMPL_FIRST_YEAR,
      maximum: 2100,
    },
    { name: "limit", type: "int", default: 50, minimum: 1, maximum: 100 },
  ],
  columns: PACMPL_COLUMNS,
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "list",
  capabilities: ["http.fetch", "scholar.venue"],
  func: async (_page, kwargs) => {
    const venue = requireText(kwargs.venue, "venue");
    const year = optionalYear(kwargs.year);
    const rows = await queryPacmpl({
      selection: resolvePacmplVenue(venue),
      year,
      limit: requireLimit(kwargs.limit),
    });
    if (rows.length === 0) {
      throw crossrefEmptyResult(
        `No PACMPL ${venue} papers matched${year ? ` year ${year}` : ""}.`,
        [`unicli pacmpl search <title> --venue ${JSON.stringify(venue)}`],
      );
    }
    return rows;
  },
});

cli({
  site: "pacmpl",
  name: "paper",
  description:
    "Fetch one PACMPL paper by ACM DOI and validate its conference issue and year",
  domain: "api.crossref.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "doi", type: "str", required: true, positional: true },
    { name: "venue", type: "str" },
    {
      name: "year",
      type: "int",
      minimum: PACMPL_FIRST_YEAR,
      maximum: 2100,
    },
  ],
  columns: PACMPL_COLUMNS,
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "get",
  capabilities: ["http.fetch", "scholar.get", "scholar.pdf"],
  func: async (_page, kwargs) => {
    const doi = requireCrossrefPrefixDoi(
      kwargs.doi ?? kwargs.id ?? kwargs.ref,
      ACM_DOI_PREFIX,
      "pacmpl",
    );
    const params = new URLSearchParams();
    const mailto = process.env.CROSSREF_MAILTO?.trim();
    if (mailto) params.set("mailto", mailto);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    const body = (await fetchCrossref(
      `/works/${encodeURIComponent(doi)}${suffix}`,
      `PACMPL work ${doi}`,
    )) as PacmplWorkResponse;
    if (!body.message) {
      throw crossrefEmptyResult(`Crossref returned no PACMPL work for ${doi}.`);
    }
    const row = mapPacmplItem(body.message);
    const venue = text(kwargs.venue);
    const selection = venue ? resolvePacmplVenue(venue) : undefined;
    const year = optionalYear(kwargs.year);
    if (!matchesPacmplSelection(row, selection, year)) {
      throw crossrefEmptyResult(
        `PACMPL work ${doi} does not match the requested venue or year.`,
        [`unicli pacmpl paper ${doi}`],
      );
    }
    return [row];
  },
});
