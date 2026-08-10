/**
 * @owner       src::adapters::acm::works
 * @does        Registers ACM publication search, proceedings browse, and DOI lookup through ACM's Crossref deposits.
 * @needs       src/adapters/_shared/crossref.ts, Crossref prefix 10.1145
 * @feeds       src/commands/scholar.ts via scholar.search, scholar.get, and scholar.venue
 * @breaks      Missing ACM Crossref deposits, metadata drift, or rate limiting surfaces as explicit adapter errors.
 * @invariants  Every returned record has DOI prefix 10.1145 and preserves ACM source provenance.
 * @side-effects HTTPS egress to api.crossref.org
 * @perf        O(limit) JSON mapping
 * @concurrency safe
 * @test        tests/unit/adapters/scholar-publishers.test.ts
 * @stability   experimental
 * @since       2026-08-09
 */

import { cli, Strategy } from "../../registry.js";
import {
  crossrefEmptyResult,
  getCrossrefWork,
  requireCrossrefPrefixDoi,
  searchCrossrefWorks,
} from "../_shared/crossref.js";
import {
  ccfConferenceIdentities,
  ccfCrossrefContainerQuery,
  ccfResidualSearchQuery,
  findCcfConferenceInText,
  resolveCcfConference,
} from "../ccf/resolve.js";
import type { ScholarlyWorkRecord } from "../../types/scholarly.js";

export const ACM_DOI_PREFIX = "10.1145";
const PACMPL_VENUE = "Proceedings of the ACM on Programming Languages";
const PACMPL_ISSN = "2475-1421";
const PACMPL_ISSUES: Record<string, string[]> = {
  ICFP: ["ICFP"],
  OOPSLA: ["OOPSLA1", "OOPSLA2"],
  PLDI: ["PLDI"],
  POPL: ["POPL"],
};
const PACMSE_VENUE = "Proceedings of the ACM on Software Engineering";
const PACMSE_ISSN = "2994-970X";
const PACMMOD_VENUE = "Proceedings of the ACM on Management of Data";
const PACMMOD_ISSN = "2836-6573";
const SIGGRAPH_VENUE = "ACM Transactions on Graphics";
const SIGGRAPH_ISSN = "0730-0301";
const VERIFIED_SIGMOD_ISSUES: Readonly<
  Record<number, ReadonlyArray<{ volume: string; issue: string }>>
> = {
  2023: [
    { volume: "1", issue: "1" },
    { volume: "1", issue: "2" },
  ],
  2024: [
    { volume: "1", issue: "3" },
    { volume: "1", issue: "4" },
    { volume: "2", issue: "1" },
    { volume: "2", issue: "3" },
  ],
  2025: [
    { volume: "2", issue: "6" },
    { volume: "3", issue: "1" },
    { volume: "3", issue: "3" },
  ],
};

interface AcmActionableError extends Error {
  code: string;
  suggestion: string;
  retryable: boolean;
  alternatives: string[];
}

function acmError(
  code: string,
  message: string,
  suggestion: string,
  alternatives: string[] = [],
): AcmActionableError {
  return Object.assign(new Error(message), {
    code,
    suggestion,
    retryable: false,
    alternatives,
  });
}

export function parseSigmodIssuePairs(
  html: string,
): Array<{ volume: string; issue: string }> {
  const pairs = new Map<string, { volume: string; issue: string }>();
  const pattern =
    /Proceedings\s+of\s+the\s+ACM\s+on\s+Management\s+of\s+Data\s*,?\s*Volume\s+(\d+)\s*,?\s*Issue\s+(\d+)/gi;
  for (const match of html.matchAll(pattern)) {
    const pair = { volume: match[1], issue: match[2] };
    pairs.set(`${pair.volume}:${pair.issue}`, pair);
  }
  const tocPattern = /\/toc\/pacmmod\/\d{4}\/(\d+)\/(\d+)/gi;
  for (const match of html.matchAll(tocPattern)) {
    const pair = { volume: match[1], issue: match[2] };
    pairs.set(`${pair.volume}:${pair.issue}`, pair);
  }
  return [...pairs.values()];
}

interface AcmPublicationJournal {
  acronym: "PACMPL" | "PACMSE" | "PACMMOD";
  containerTitle: string;
  issn: string;
}

const ACM_PUBLICATION_JOURNALS: readonly AcmPublicationJournal[] = [
  {
    acronym: "PACMPL",
    containerTitle: PACMPL_VENUE,
    issn: PACMPL_ISSN,
  },
  {
    acronym: "PACMSE",
    containerTitle: PACMSE_VENUE,
    issn: PACMSE_ISSN,
  },
  {
    acronym: "PACMMOD",
    containerTitle: PACMMOD_VENUE,
    issn: PACMMOD_ISSN,
  },
];

function compactVenue(value: unknown): string {
  return typeof value === "string"
    ? value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "")
        .trim()
    : "";
}

export function resolveAcmPublicationJournal(
  value: unknown,
): AcmPublicationJournal | undefined {
  const target = compactVenue(value);
  return ACM_PUBLICATION_JOURNALS.find(
    (journal) =>
      target === compactVenue(journal.acronym) ||
      target === compactVenue(journal.containerTitle),
  );
}

function findAcmPublicationJournalInText(
  value: string,
): AcmPublicationJournal | undefined {
  const normalized = value.toLowerCase();
  return ACM_PUBLICATION_JOURNALS.find(
    (journal) =>
      new RegExp(`\\b${journal.acronym.toLowerCase()}\\b`, "i").test(value) ||
      normalized.includes(journal.containerTitle.toLowerCase()),
  );
}

function journalResidualQuery(
  value: string,
  journal: AcmPublicationJournal,
): string | undefined {
  const identities = [journal.acronym, journal.containerTitle];
  let residual = value.replace(/\b(?:19|20)\d{2}\b/g, " ");
  for (const identity of identities) {
    residual = residual.replace(
      new RegExp(identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
      " ",
    );
  }
  residual = residual.replace(/\s+/g, " ").trim();
  return residual || undefined;
}

async function searchAcmPublicationJournal(options: {
  journal: AcmPublicationJournal;
  year?: number;
  limit: number;
  query?: string;
}): Promise<ScholarlyWorkRecord[]> {
  return searchCrossrefWorks(
    {
      query: options.query,
      containerTitle: options.journal.containerTitle,
      issn: options.journal.issn,
      type: "journal-article",
      year: options.year,
      researchContentOnly: true,
      limit: options.limit,
    },
    "acm",
  );
}

export function pacmplIssuesForConferenceYear(
  acronym: string,
  year: number,
): string[] | undefined {
  if (acronym !== "OOPSLA") return PACMPL_ISSUES[acronym];
  return year < 2022 ? ["OOPSLA"] : ["OOPSLA1", "OOPSLA2"];
}

export function siggraphVolumeIssue(year: number): {
  volume: string;
  issue: string;
} {
  return { volume: String(year - 1981), issue: "4" };
}

async function sigmodIssuePairs(
  year: number,
): Promise<Array<{ volume: string; issue: string }>> {
  const verified = VERIFIED_SIGMOD_ISSUES[year];
  if (verified) return verified.map((pair) => ({ ...pair }));
  const url = `https://${year}.sigmod.org/sigmod_papers.shtml`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "text/html",
        "User-Agent": "unicli-acm/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw Object.assign(
        acmError(
          "timeout",
          `SIGMOD ${year} accepted-paper index timed out.`,
          "Retry after the official SIGMOD conference site is reachable.",
          [`unicli scholar venue SIGMOD --year ${year}`],
        ),
        { retryable: true },
      );
    }
    throw error;
  }
  if (!response.ok) {
    throw Object.assign(
      acmError(
        "upstream_error",
        `SIGMOD ${year} accepted-paper index returned HTTP ${response.status}.`,
        "Retry after the official SIGMOD conference site is reachable.",
      ),
      { retryable: response.status >= 500 },
    );
  }
  const pairs = parseSigmodIssuePairs(await response.text());
  if (pairs.length === 0) {
    throw acmError(
      "empty_result",
      `SIGMOD ${year} accepted-paper index exposes no PACMMOD issue links.`,
      "Verify the conference year or inspect the official accepted-paper page.",
      [url],
    );
  }
  return pairs;
}

function conferenceJournalRows(
  rows: ScholarlyWorkRecord[],
  acronym: string,
  conferenceYear: number,
): ScholarlyWorkRecord[] {
  return rows.map((row) => ({
    ...row,
    publication_year: row.year,
    conference_year: conferenceYear,
    year: conferenceYear,
    venue: `${acronym} ${conferenceYear}`,
    raw: {
      ...(row.raw && typeof row.raw === "object" ? row.raw : {}),
      publication_venue: row.venue,
      publication_year: row.year,
      conference_year: conferenceYear,
    },
  }));
}

async function searchAcmConferenceJournal(options: {
  acronym: string;
  year: number;
  limit: number;
  query?: string;
}): Promise<ScholarlyWorkRecord[] | undefined> {
  const pacmplIssues = pacmplIssuesForConferenceYear(
    options.acronym,
    options.year,
  );
  if (pacmplIssues) {
    const rows = await searchCrossrefWorks(
      {
        query: options.query,
        containerTitle: PACMPL_VENUE,
        issn: PACMPL_ISSN,
        type: "journal-article",
        issues: pacmplIssues,
        year: options.year,
        researchContentOnly: true,
        limit: options.limit,
      },
      "acm",
    );
    return conferenceJournalRows(rows, options.acronym, options.year);
  }
  if (options.acronym === "SIGGRAPH" && options.year >= 1982) {
    const rows = await searchCrossrefWorks(
      {
        query: options.query,
        containerTitle: SIGGRAPH_VENUE,
        issn: SIGGRAPH_ISSN,
        type: "journal-article",
        volumeIssues: [siggraphVolumeIssue(options.year)],
        year: options.year,
        researchContentOnly: true,
        limit: options.limit,
      },
      "acm",
    );
    return conferenceJournalRows(rows, "SIGGRAPH", options.year);
  }
  if (options.acronym === "FSE" && options.year >= 2024) {
    const rows = await searchCrossrefWorks(
      {
        query: options.query,
        containerTitle: PACMSE_VENUE,
        issn: PACMSE_ISSN,
        type: "journal-article",
        issues: ["FSE"],
        year: options.year,
        researchContentOnly: true,
        limit: options.limit,
      },
      "acm",
    );
    return conferenceJournalRows(rows, "FSE", options.year);
  }
  if (options.acronym === "SIGMOD" && options.year >= 2023) {
    const volumeIssues = await sigmodIssuePairs(options.year);
    const rows = (
      await Promise.all(
        [options.year - 1, options.year].map((publicationYear) =>
          searchCrossrefWorks(
            {
              query: options.query,
              containerTitle: PACMMOD_VENUE,
              issn: PACMMOD_ISSN,
              type: "journal-article",
              volumeIssues,
              year: publicationYear,
              researchContentOnly: true,
              limit: 100,
            },
            "acm",
          ),
        ),
      )
    ).flat();
    const unique = [
      ...new Map(rows.map((row) => [row.doi ?? row.id, row])).values(),
    ].slice(0, options.limit);
    return conferenceJournalRows(unique, "SIGMOD", options.year);
  }
  return undefined;
}

function optionalYear(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1947 || year > 2100) {
    throw acmError(
      "invalid_input",
      `acm year must be an integer in [1947, 2100].`,
      "Choose a publication or conference year from 1947 through 2100.",
    );
  }
  return year;
}

function limit(value: unknown): number {
  const result = Number(value ?? 20);
  if (!Number.isInteger(result) || result < 1 || result > 100) {
    throw acmError(
      "invalid_input",
      "acm limit must be an integer in [1, 100].",
      "Choose a limit from 1 through 100.",
    );
  }
  return result;
}

function requireText(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!text) {
    throw acmError(
      "invalid_input",
      `acm ${label} cannot be empty.`,
      `Provide a non-empty ACM ${label}.`,
    );
  }
  return text;
}

function embeddedYear(value: string): number | undefined {
  const match = value.match(/\b(?:19|20)\d{2}\b/);
  return match ? Number(match[0]) : undefined;
}

cli({
  site: "acm",
  name: "search",
  description:
    "Search ACM publications from official DOI registration metadata",
  domain: "api.crossref.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "venue", type: "str" },
    { name: "year", type: "int", minimum: 1947, maximum: 2100 },
    { name: "limit", type: "int", default: 20, minimum: 1, maximum: 100 },
  ],
  columns: [
    "id",
    "title",
    "authors",
    "year",
    "venue",
    "type",
    "doi",
    "pdf_url",
    "source_url",
  ],
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
    const explicitVenue =
      typeof kwargs.venue === "string" && kwargs.venue.trim()
        ? kwargs.venue.trim()
        : undefined;
    const publicationJournal = explicitVenue
      ? resolveAcmPublicationJournal(explicitVenue)
      : findAcmPublicationJournalInText(query);
    const explicitConference = explicitVenue
      ? resolveCcfConference(explicitVenue)
      : undefined;
    const inferredConference = explicitConference
      ? undefined
      : findCcfConferenceInText(query);
    const conference = explicitConference ?? inferredConference;
    const requestedYear = optionalYear(kwargs.year) ?? embeddedYear(query);
    const requestedLimit = limit(kwargs.limit);
    const paperQuery = publicationJournal
      ? journalResidualQuery(query, publicationJournal)
      : inferredConference
        ? ccfResidualSearchQuery(query, inferredConference)
        : query;
    const journalRows = publicationJournal
      ? await searchAcmPublicationJournal({
          journal: publicationJournal,
          year: requestedYear,
          limit: requestedLimit,
          query: paperQuery,
        })
      : conference && requestedYear
        ? await searchAcmConferenceJournal({
            acronym: conference.acronym,
            year: requestedYear,
            limit: requestedLimit,
            query: paperQuery,
          })
        : undefined;
    const rows =
      journalRows ??
      (await searchCrossrefWorks(
        {
          query: paperQuery,
          containerTitle: conference
            ? ccfCrossrefContainerQuery(conference)
            : undefined,
          venueAliases: conference
            ? [conference.name, ...ccfConferenceIdentities(conference)]
            : undefined,
          prefix: ACM_DOI_PREFIX,
          year: requestedYear,
          researchContentOnly: true,
          limit: requestedLimit,
        },
        "acm",
      ));
    if (rows.length === 0) {
      throw crossrefEmptyResult(`No ACM publications matched "${query}".`, [
        `unicli scholar search ${JSON.stringify(query)}`,
      ]);
    }
    return rows;
  },
});

cli({
  site: "acm",
  name: "venue",
  description: "List ACM proceedings papers for a conference or venue",
  domain: "api.crossref.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "venue", type: "str", required: true, positional: true },
    { name: "year", type: "int", minimum: 1947, maximum: 2100 },
    { name: "limit", type: "int", default: 50, minimum: 1, maximum: 100 },
  ],
  columns: ["id", "title", "authors", "year", "venue", "doi", "source_url"],
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "list",
  capabilities: ["http.fetch", "scholar.venue"],
  func: async (_page, kwargs) => {
    const venue = requireText(kwargs.venue, "venue");
    const publicationJournal = resolveAcmPublicationJournal(venue);
    const conference = resolveCcfConference(venue);
    const requestedYear = optionalYear(kwargs.year);
    const requestedLimit = limit(kwargs.limit);
    const journalRows = publicationJournal
      ? await searchAcmPublicationJournal({
          journal: publicationJournal,
          year: requestedYear,
          limit: requestedLimit,
        })
      : conference && requestedYear
        ? await searchAcmConferenceJournal({
            acronym: conference.acronym,
            year: requestedYear,
            limit: requestedLimit,
          })
        : undefined;
    const issues =
      conference && requestedYear
        ? pacmplIssuesForConferenceYear(conference.acronym, requestedYear)
        : conference
          ? PACMPL_ISSUES[conference.acronym]
          : undefined;
    const rows =
      journalRows ??
      (await searchCrossrefWorks(
        {
          containerTitle: issues
            ? PACMPL_VENUE
            : conference
              ? ccfCrossrefContainerQuery(conference)
              : venue,
          venueAliases: conference
            ? [conference.name, ...ccfConferenceIdentities(conference), venue]
            : undefined,
          prefix: ACM_DOI_PREFIX,
          type: issues ? "journal-article" : "proceedings-article",
          issues,
          year: requestedYear,
          researchContentOnly: true,
          limit: requestedLimit,
        },
        "acm",
      ));
    if (rows.length === 0) {
      throw crossrefEmptyResult(
        `No ACM proceedings papers matched "${venue}".`,
        [`unicli scholar venue ${JSON.stringify(venue)}`],
      );
    }
    return rows;
  },
});

cli({
  site: "acm",
  name: "paper",
  description: "Fetch one ACM publication by DOI",
  domain: "api.crossref.org",
  strategy: Strategy.PUBLIC,
  args: [{ name: "doi", type: "str", required: true, positional: true }],
  columns: [
    "id",
    "title",
    "authors",
    "year",
    "venue",
    "type",
    "doi",
    "pdf_url",
    "source_url",
  ],
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "get",
  capabilities: ["http.fetch", "scholar.get", "scholar.pdf"],
  func: async (_page, kwargs) => {
    const doi = requireCrossrefPrefixDoi(
      kwargs.doi ?? kwargs.id ?? kwargs.ref,
      ACM_DOI_PREFIX,
      "acm",
    );
    return [await getCrossrefWork(doi, "acm")];
  },
});
