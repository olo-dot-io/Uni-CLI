/**
 * @owner       src::adapters::sigchi::programs
 * @does        Registers official SIGCHI conference discovery, program paper listing, and award lookup from the public program cache.
 * @needs       files.sigchi.org public conference cache
 * @feeds       Direct conference research and src/commands/scholar.ts cross-site context and award tracing
 * @breaks      Conference-cache schema or route drift surfaces as explicit adapter errors.
 * @invariants  Awards come only from the official SIGCHI program record; DOI links retain their ACM registration; authors resolve from the same program snapshot.
 * @side-effects HTTPS egress to files.sigchi.org
 * @perf        One conference-list request plus two bounded program requests; local filtering is O(program contents)
 * @concurrency safe
 * @test        tests/unit/adapters/scholar-publishers.test.ts
 * @stability   experimental
 * @since       2026-08-09
 */

import { cli, Strategy } from "../../registry.js";
import type { ScholarlyContextRecord } from "../../types/scholarly.js";

const CACHE = "https://files.sigchi.org/conference/cache";

export interface SigchiConference {
  id?: unknown;
  shortName?: unknown;
  displayShortName?: unknown;
  year?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  fullName?: unknown;
  name?: unknown;
  url?: unknown;
  location?: unknown;
  timeZoneName?: unknown;
}

interface SigchiPublicationInfo {
  publicationStatus?: unknown;
  isProgramEnabled?: unknown;
  isDraft?: unknown;
  version?: unknown;
}

export interface SigchiConferenceEntry {
  conference?: SigchiConference;
  publicationInfo?: SigchiPublicationInfo;
}

interface SigchiPerson {
  id?: unknown;
  firstName?: unknown;
  middleInitial?: unknown;
  lastName?: unknown;
}

interface SigchiContentAuthor {
  personId?: unknown;
  affiliations?: unknown;
}

export interface SigchiContent {
  id?: unknown;
  typeId?: unknown;
  title?: unknown;
  abstract?: unknown;
  award?: unknown;
  recognitionIds?: unknown[];
  isBreak?: unknown;
  authors?: SigchiContentAuthor[];
  addons?: Record<
    string,
    | { name?: unknown; title?: unknown; type?: unknown; url?: unknown }
    | undefined
  >;
}

interface SigchiContentType {
  id?: unknown;
  name?: unknown;
  displayName?: unknown;
}

export interface SigchiProgram {
  conference?: SigchiConference;
  publicationInfo?: SigchiPublicationInfo;
  contents?: SigchiContent[];
  people?: SigchiPerson[];
  contentTypes?: SigchiContentType[];
  recognitions?: unknown[];
}

interface SigchiVersionEnvelope {
  scheduleVersion?: unknown;
}

interface SigchiActionableError extends Error {
  code: string;
  suggestion: string;
  retryable: boolean;
  alternatives: string[];
}

function sigchiError(
  code: string,
  message: string,
  suggestion: string,
  retryable = false,
): SigchiActionableError {
  return Object.assign(new Error(message), {
    code,
    suggestion,
    retryable,
    alternatives: [],
  });
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function integer(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function normalize(value: unknown): string {
  return text(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function words(value: unknown): string[] {
  return normalize(value).split(/\s+/).filter(Boolean);
}

function boundedLimit(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  const limit =
    value === undefined || value === null || value === ""
      ? fallback
      : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw sigchiError(
      "invalid_input",
      `sigchi limit must be an integer in [1, ${maximum}].`,
      `Choose a limit from 1 through ${maximum}.`,
    );
  }
  return limit;
}

function optionalYear(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const year = Number(value);
  if (!Number.isInteger(year) || year < 2018 || year > 2100) {
    throw sigchiError(
      "invalid_input",
      "sigchi year must be an integer in [2018, 2100].",
      "Choose a SIGCHI program year from 2018 through 2100.",
    );
  }
  return year;
}

async function fetchJson<T>(url: string, label: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    const timedOut =
      cause instanceof Error &&
      (cause.name === "TimeoutError" || cause.name === "AbortError");
    throw sigchiError(
      timedOut ? "timeout" : "upstream_error",
      `${label} request ${timedOut ? "timed out" : "failed"}.`,
      "Retry after the official SIGCHI program cache is reachable.",
      true,
    );
  }
  if (response.status === 404)
    throw sigchiError(
      "empty_result",
      `${label} returned no result.`,
      "Verify the conference and program year.",
    );
  if (response.status === 429) {
    throw sigchiError(
      "rate_limited",
      `${label} returned HTTP 429.`,
      "Retry after the SIGCHI program cache rate limit resets.",
      true,
    );
  }
  if (!response.ok)
    throw sigchiError(
      "upstream_error",
      `${label} returned HTTP ${response.status}.`,
      "Retry after the official SIGCHI program cache is reachable.",
      response.status >= 500,
    );
  return (await response.json()) as T;
}

export async function fetchSigchiConferenceList(): Promise<
  SigchiConferenceEntry[]
> {
  return fetchJson<SigchiConferenceEntry[]>(
    `${CACHE}/program-list`,
    "SIGCHI conference list",
  );
}

function conferenceScore(entry: SigchiConferenceEntry, query: string): number {
  const conference = entry.conference ?? {};
  const target = normalize(query);
  if (!target) return 1;
  const shortName = normalize(conference.shortName);
  const name = normalize(conference.name);
  const fullName = normalize(conference.fullName);
  if (target === shortName) return 100;
  if (target === name) return 95;
  if (target === fullName) return 90;
  if (name.includes(target)) return 80;
  if (fullName.includes(target)) return 75;
  const queryWords = words(query);
  const fullWords = new Set(words(conference.fullName));
  if (shortName && queryWords.includes(shortName)) return 70;
  if (
    queryWords.length > 1 &&
    queryWords.every((word) => fullWords.has(word))
  ) {
    return 60;
  }
  return 0;
}

export function resolveSigchiConference(
  entries: SigchiConferenceEntry[],
  query: unknown,
  yearValue?: unknown,
): SigchiConferenceEntry {
  const label = text(query);
  if (!label)
    throw sigchiError(
      "invalid_input",
      "sigchi conference cannot be empty.",
      "Pass a SIGCHI conference acronym or full name.",
    );
  const year = optionalYear(yearValue);
  const matches = entries
    .map((entry) => ({ entry, score: conferenceScore(entry, label) }))
    .filter(({ entry, score }) => {
      if (score === 0) return false;
      return year === undefined || integer(entry.conference?.year) === year;
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return (
        (integer(right.entry.conference?.year) ?? 0) -
        (integer(left.entry.conference?.year) ?? 0)
      );
    });
  if (matches.length === 0) {
    throw sigchiError(
      "empty_result",
      `SIGCHI returned no conference for "${label}"${year ? ` in ${year}` : ""}.`,
      "Verify the SIGCHI conference acronym and year.",
    );
  }
  return matches[0]!.entry;
}

export async function fetchSigchiProgram(
  entry: SigchiConferenceEntry,
): Promise<SigchiProgram> {
  const conferenceId = integer(entry.conference?.id);
  if (!conferenceId)
    throw sigchiError(
      "parse_error",
      "SIGCHI conference record has no id.",
      "Retry after the official SIGCHI conference list is repaired.",
    );
  const version = await fetchJson<SigchiVersionEnvelope>(
    `${CACHE}/${conferenceId}/version-2`,
    `SIGCHI conference ${conferenceId} version`,
  );
  const scheduleVersion = integer(version.scheduleVersion);
  if (!scheduleVersion) {
    throw sigchiError(
      "parse_error",
      `SIGCHI conference ${conferenceId} has no program version.`,
      "Retry after the official SIGCHI program is published.",
    );
  }
  return fetchJson<SigchiProgram>(
    `${CACHE}/${conferenceId}/${scheduleVersion}/program`,
    `SIGCHI conference ${conferenceId} program`,
  );
}

function doiFromContent(content: SigchiContent): string | undefined {
  for (const addon of Object.values(content.addons ?? {})) {
    const url = text(addon?.url);
    const doi = url.match(
      /^(?:(?:https?:\/\/)?(?:dx\.)?doi\.org\/)?(10\.\S+\/\S+)$/i,
    )?.[1];
    if (doi) return doi;
  }
  return undefined;
}

function awardLabel(value: unknown): string | undefined {
  const award = text(value);
  return award
    ? award
        .toLowerCase()
        .split("_")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ")
    : undefined;
}

function contentUrl(conference: SigchiConference, contentId: string): string {
  const shortName = normalize(conference.shortName).replace(/\s+/g, "");
  const year = integer(conference.year);
  return shortName && year
    ? `https://programs.sigchi.org/${shortName}/${year}/program/content/${contentId}`
    : text(conference.url);
}

export function mapSigchiContent(
  content: SigchiContent,
  program: SigchiProgram,
): ScholarlyContextRecord {
  const conference = program.conference ?? {};
  const people = new Map(
    (program.people ?? []).map(
      (person) => [integer(person.id), person] as const,
    ),
  );
  const typeNames = new Map(
    (program.contentTypes ?? []).map(
      (type) =>
        [integer(type.id), text(type.displayName) || text(type.name)] as const,
    ),
  );
  const authors = (content.authors ?? [])
    .map((author) => people.get(integer(author.personId)))
    .filter((person): person is SigchiPerson => Boolean(person))
    .map((person) =>
      [person.firstName, person.middleInitial, person.lastName]
        .map(text)
        .filter(Boolean)
        .join(" "),
    )
    .filter(Boolean);
  const id = String(integer(content.id) ?? text(content.id));
  const doi = doiFromContent(content);
  const sourceUrl = contentUrl(conference, id);
  const award = awardLabel(content.award);
  return {
    id,
    title: text(content.title),
    relation: award ? "official-award" : "official-program",
    authors: authors.length > 0 ? authors : undefined,
    year: integer(conference.year),
    venue: text(conference.name) || text(conference.fullName) || undefined,
    type: typeNames.get(integer(content.typeId)) || undefined,
    abstract: text(content.abstract) || undefined,
    doi,
    award,
    landing_url: doi ? `https://doi.org/${doi}` : sourceUrl,
    source_adapter: "sigchi",
    source_url: sourceUrl,
    retrieved_at: new Date().toISOString(),
    raw: {
      conference_id: integer(conference.id),
      conference_name: text(conference.fullName) || undefined,
      conference_url: text(conference.url) || undefined,
      recognition_ids: content.recognitionIds,
      addons: content.addons,
    },
  };
}

function searchable(row: ScholarlyContextRecord): string {
  return normalize(
    [row.title, row.abstract, row.authors?.join(" "), row.doi, row.award].join(
      " ",
    ),
  );
}

function mapConference(entry: SigchiConferenceEntry): ScholarlyContextRecord {
  const conference = entry.conference ?? {};
  const id = String(integer(conference.id) ?? text(conference.id));
  const sourceUrl = text(conference.url) || "https://programs.sigchi.org";
  return {
    id,
    title: text(conference.name) || text(conference.fullName),
    relation: "official-conference",
    year: integer(conference.year),
    venue: text(conference.shortName) || undefined,
    landing_url: sourceUrl,
    source_adapter: "sigchi",
    source_url: sourceUrl,
    retrieved_at: new Date().toISOString(),
    raw: {
      full_name: text(conference.fullName) || undefined,
      location: text(conference.location) || undefined,
      start_date: integer(conference.startDate),
      end_date: integer(conference.endDate),
      time_zone: text(conference.timeZoneName) || undefined,
      publication_status:
        text(entry.publicationInfo?.publicationStatus) || undefined,
      program_enabled: entry.publicationInfo?.isProgramEnabled,
    },
  };
}

const paperColumns = [
  "id",
  "title",
  "authors",
  "year",
  "venue",
  "type",
  "doi",
  "award",
  "landing_url",
  "source_url",
];

cli({
  site: "sigchi",
  name: "conferences",
  description:
    "List official SIGCHI conference editions and program availability",
  domain: "files.sigchi.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "query", type: "str", positional: true },
    { name: "year", type: "int", minimum: 2018, maximum: 2100 },
    { name: "limit", type: "int", default: 50, minimum: 1, maximum: 500 },
  ],
  columns: ["id", "title", "year", "venue", "landing_url", "source_url"],
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "list",
  capabilities: ["http.fetch", "scholar.context"],
  func: async (_page, kwargs) => {
    const query = text(kwargs.query);
    const year = optionalYear(kwargs.year);
    const limit = boundedLimit(kwargs.limit, 50, 500);
    const entries = await fetchSigchiConferenceList();
    const rows = entries
      .filter((entry) => {
        if (year !== undefined && integer(entry.conference?.year) !== year)
          return false;
        return !query || conferenceScore(entry, query) > 0;
      })
      .sort(
        (left, right) =>
          (integer(right.conference?.year) ?? 0) -
          (integer(left.conference?.year) ?? 0),
      )
      .slice(0, limit)
      .map(mapConference);
    if (rows.length === 0)
      throw sigchiError(
        "empty_result",
        `No SIGCHI conferences matched "${query}".`,
        "Try a conference acronym, full name, or another year.",
      );
    return rows;
  },
});

cli({
  site: "sigchi",
  name: "papers",
  description:
    "List papers and program content from an official SIGCHI conference",
  domain: "files.sigchi.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "conference", type: "str", required: true, positional: true },
    { name: "year", type: "int", minimum: 2018, maximum: 2100 },
    { name: "query", type: "str" },
    { name: "limit", type: "int", default: 50, minimum: 1, maximum: 500 },
  ],
  columns: paperColumns,
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "list",
  capabilities: ["http.fetch", "scholar.venue", "scholar.context"],
  func: async (_page, kwargs) => {
    const entries = await fetchSigchiConferenceList();
    const entry = resolveSigchiConference(
      entries,
      kwargs.conference ?? kwargs.venue,
      kwargs.year,
    );
    const program = await fetchSigchiProgram(entry);
    const query = normalize(kwargs.query);
    const limit = boundedLimit(kwargs.limit, 50, 500);
    const rows = (program.contents ?? [])
      .filter((content) => content.isBreak !== true && text(content.title))
      .map((content) => mapSigchiContent(content, program))
      .filter((row) => !query || searchable(row).includes(query))
      .slice(0, limit);
    if (rows.length === 0)
      throw sigchiError(
        "empty_result",
        "SIGCHI program returned no matching content.",
        "Broaden the paper query or verify the conference year.",
      );
    return rows;
  },
});

cli({
  site: "sigchi",
  name: "awards",
  description: "List officially marked award papers from a SIGCHI conference",
  domain: "files.sigchi.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "conference", type: "str", required: true, positional: true },
    { name: "year", type: "int", minimum: 2018, maximum: 2100 },
    { name: "query", type: "str" },
    {
      name: "award",
      type: "str",
      choices: ["all", "best-paper", "honorable-mention"],
      default: "all",
    },
    { name: "limit", type: "int", default: 100, minimum: 1, maximum: 500 },
  ],
  columns: paperColumns,
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "list",
  capabilities: ["http.fetch", "scholar.awards", "scholar.context"],
  func: async (_page, kwargs) => {
    const entries = await fetchSigchiConferenceList();
    const entry = resolveSigchiConference(
      entries,
      kwargs.conference ?? kwargs.venue,
      kwargs.year,
    );
    const program = await fetchSigchiProgram(entry);
    const query = normalize(kwargs.query);
    const awardFilter = text(kwargs.award) || "all";
    const limit = boundedLimit(kwargs.limit, 100, 500);
    const rows = (program.contents ?? [])
      .filter((content) => text(content.award))
      .map((content) => mapSigchiContent(content, program))
      .filter((row) => {
        if (query && !searchable(row).includes(query)) return false;
        if (awardFilter === "best-paper") return row.award === "Best Paper";
        if (awardFilter === "honorable-mention") {
          return row.award === "Honorable Mention";
        }
        return true;
      })
      .slice(0, limit);
    if (rows.length === 0)
      throw sigchiError(
        "empty_result",
        "SIGCHI program returned no matching awards.",
        "Broaden the award query or verify the conference year.",
      );
    return rows;
  },
});
