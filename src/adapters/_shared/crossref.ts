/**
 * @owner       src::adapters::_shared::crossref
 * @does        Shares Crossref REST request, filtering, DOI validation, and normalized work mapping across Crossref and publisher adapters.
 * @needs       api.crossref.org REST API, optional CROSSREF_MAILTO, src/types/scholarly.ts
 * @feeds       src/adapters/crossref, src/adapters/acm, src/adapters/ieee
 * @breaks      Crossref response drift, invalid DOI input, or upstream rate limits surface as explicit errors.
 * @invariants  Publisher filters remain explicit; DOI lookups never accept non-DOI references; normalized rows keep the requesting adapter as provenance.
 * @side-effects HTTPS egress to api.crossref.org
 * @perf        O(limit) JSON mapping
 * @concurrency safe
 * @test        tests/unit/adapters/scholar-publishers.test.ts, tests/unit/adapters/scholar-sources.test.ts
 * @stability   experimental
 * @since       2026-08-09
 */

import type { ScholarlyWorkRecord } from "../../types/scholarly.js";

const API = "https://api.crossref.org";

export interface CrossrefPerson {
  given?: unknown;
  family?: unknown;
  name?: unknown;
}

export interface CrossrefItem {
  DOI?: unknown;
  title?: unknown[];
  subtitle?: unknown[];
  author?: CrossrefPerson[];
  "container-title"?: unknown[];
  issued?: { "date-parts"?: unknown[][] };
  published?: { "date-parts"?: unknown[][] };
  "published-online"?: { "date-parts"?: unknown[][] };
  "is-referenced-by-count"?: unknown;
  reference?: unknown[];
  URL?: unknown;
  type?: unknown;
  subtype?: unknown;
  volume?: unknown;
  issue?: unknown;
  abstract?: unknown;
  publisher?: unknown;
  member?: unknown;
  prefix?: unknown;
  link?: Array<{
    URL?: unknown;
    "content-type"?: unknown;
    "content-version"?: unknown;
    "intended-application"?: unknown;
  }>;
  license?: Array<{ URL?: unknown }>;
  relation?: unknown;
}

interface CrossrefWorksResponse {
  message?: { items?: CrossrefItem[] };
}

interface CrossrefWorkResponse {
  message?: CrossrefItem;
}

export interface CrossrefSearchOptions {
  query?: string;
  title?: string;
  containerTitle?: string;
  venueAliases?: string[];
  prefix?: string;
  publisher?: string;
  issn?: string;
  year?: number;
  type?: string;
  issues?: string[];
  volumeIssues?: Array<{ volume: string; issue: string }>;
  researchContentOnly?: boolean;
  limit: number;
}

interface CrossrefActionableError extends Error {
  code: string;
  suggestion: string;
  retryable: boolean;
  alternatives: string[];
}

const CROSSREF_TIMEOUT_MS = 15_000;
const CROSSREF_MIN_INTERVAL_MS = 100;
const CROSSREF_MAX_RETRY_AFTER_MS = 5_000;
let crossrefQueue: Promise<void> = Promise.resolve();
let nextCrossrefRequestAt = 0;

function crossrefError(
  code: string,
  message: string,
  suggestion: string,
  options: { retryable?: boolean; alternatives?: string[] } = {},
): CrossrefActionableError {
  return Object.assign(new Error(message), {
    code,
    suggestion,
    retryable: options.retryable ?? false,
    alternatives: options.alternatives ?? [],
  });
}

export function crossrefEmptyResult(
  message: string,
  alternatives: string[] = [],
): Error {
  return crossrefError(
    "empty_result",
    message,
    "Broaden the query, verify the venue and year, or select another scholarly source.",
    { alternatives },
  );
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function arrFirst(value: unknown): string {
  return Array.isArray(value) ? str(value[0]) : str(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function dateParts(item: CrossrefItem): unknown[] {
  return (
    item.issued?.["date-parts"]?.[0] ??
    item.published?.["date-parts"]?.[0] ??
    item["published-online"]?.["date-parts"]?.[0] ??
    []
  );
}

function year(item: CrossrefItem): number | undefined {
  const first = dateParts(item)[0];
  return typeof first === "number" && Number.isFinite(first)
    ? first
    : undefined;
}

function date(item: CrossrefItem): string | undefined {
  const parts = dateParts(item).filter(
    (part): part is number => typeof part === "number",
  );
  if (parts.length === 0) return undefined;
  return [
    String(parts[0]).padStart(4, "0"),
    String(parts[1] ?? 1).padStart(2, "0"),
    String(parts[2] ?? 1).padStart(2, "0"),
  ].join("-");
}

function authors(value: CrossrefPerson[] | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map(
      (person) =>
        str(person.name) ||
        [person.given, person.family].map(str).filter(Boolean).join(" "),
    )
    .filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function pdfUrl(item: CrossrefItem): string | undefined {
  const links = Array.isArray(item.link) ? item.link : [];
  const pdf = links.find(
    (link) => str(link["content-type"]).toLowerCase() === "application/pdf",
  );
  return str(pdf?.URL) || undefined;
}

export function bareCrossrefDoi(value: unknown): string {
  return str(value)
    .replace(/^doi:/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
}

export function requireCrossrefDoi(value: unknown): string {
  const doi = bareCrossrefDoi(value);
  if (!/^10\.\S+\/\S+/.test(doi)) {
    throw crossrefError(
      "invalid_input",
      `crossref DOI "${String(value ?? "")}" is not recognised.`,
      "Provide a DOI such as 10.1145/123.456 or search by paper title first.",
      { alternatives: ["unicli scholar search <title>"] },
    );
  }
  return doi;
}

export function requireCrossrefPrefixDoi(
  value: unknown,
  prefix: string,
  source: string,
): string {
  const doi = requireCrossrefDoi(value);
  if (!doi.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)) {
    throw crossrefError(
      "invalid_input",
      `${source} DOI "${doi}" does not use prefix ${prefix}.`,
      `Use the publisher adapter that owns the DOI prefix, or resolve it with the source-neutral scholar command.`,
      {
        alternatives: [
          `unicli scholar get ${doi}`,
          `unicli crossref work ${doi}`,
        ],
      },
    );
  }
  return doi;
}

function normalizeVenue(value: unknown): string {
  return str(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/&/g, " and ")
    .replace(/\b(?:18|19|20)\d{2}\b/g, " ")
    .replace(/\b\d+(?:st|nd|rd|th)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const VENUE_PUBLISHER_WORDS = new Set(["acm", "ieee", "siam"]);
const VENUE_GENERIC_WORDS = new Set([
  "annual",
  "association",
  "conference",
  "conferences",
  "congress",
  "international",
  "joint",
  "meeting",
  "proceeding",
  "proceedings",
  "society",
  "symposium",
  "workshop",
  "workshops",
  "world",
]);
const VENUE_CONNECTOR_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "in",
  "of",
  "on",
  "the",
  "to",
]);

const VENUE_ORDINAL_WORDS = new Set([
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
  "eleventh",
  "twelfth",
  "thirteenth",
  "fourteenth",
  "fifteenth",
  "sixteenth",
  "seventeenth",
  "eighteenth",
  "nineteenth",
  "twentieth",
  "twenty",
  "twenty-first",
  "twenty-second",
  "twenty-third",
  "twenty-fourth",
  "twenty-fifth",
  "twenty-sixth",
  "twenty-seventh",
  "twenty-eighth",
  "twenty-ninth",
  "thirtieth",
  "thirty",
  "thirty-first",
  "thirty-second",
  "thirty-third",
  "thirty-fourth",
  "thirty-fifth",
  "thirty-sixth",
  "thirty-seventh",
  "thirty-eighth",
  "thirty-ninth",
  "fortieth",
  "forty",
]);

function venueWords(value: unknown): string[] {
  const normalized = normalizeVenue(value);
  return normalized ? normalized.split(" ") : [];
}

function initials(words: string[]): string {
  return words.map((word) => word[0] ?? "").join("");
}

function acronymCandidates(value: unknown): Set<string> {
  const words = venueWords(value).filter(
    (word) =>
      !VENUE_PUBLISHER_WORDS.has(word) &&
      !/^sig[a-z0-9]+$/.test(word) &&
      !/^\d+$/.test(word),
  );
  const withoutProceedings = words.filter(
    (word) => !["proceeding", "proceedings"].includes(word),
  );
  const significant = withoutProceedings.filter(
    (word) =>
      !VENUE_GENERIC_WORDS.has(word) && !VENUE_CONNECTOR_WORDS.has(word),
  );
  const keepOf = withoutProceedings.filter(
    (word) =>
      !VENUE_GENERIC_WORDS.has(word) &&
      !["a", "an", "and", "for", "in", "on", "the", "to"].includes(word),
  );
  const candidates = new Set<string>();
  const keepGeneric = withoutProceedings.filter(
    (word) => !VENUE_CONNECTOR_WORDS.has(word),
  );
  for (const candidate of [
    initials(significant),
    initials(keepOf),
    initials(keepGeneric),
  ]) {
    if (candidate.length >= 2) candidates.add(candidate);
  }
  return candidates;
}

function queryAcronym(value: unknown): string | undefined {
  const words = venueWords(value).filter(
    (word) =>
      !VENUE_PUBLISHER_WORDS.has(word) &&
      !VENUE_CONNECTOR_WORDS.has(word) &&
      !/^\d+$/.test(word),
  );
  if (words.length === 0 || words.length > 2) return undefined;
  if (words.some((word) => word.length > 12)) return undefined;
  const compact = words.join("");
  return compact.length >= 2 && compact.length <= 12 ? compact : undefined;
}

const VENUE_QUALIFIER_WORDS = new Set([
  "adjunct",
  "companion",
  "demo",
  "demos",
  "doctoral",
  "poster",
  "posters",
  "supplement",
  "workshop",
  "workshops",
  "course",
  "courses",
  "doctoral",
  "educator",
  "educators",
  "emerging",
  "exhibition",
  "exhibitions",
  "forum",
  "forums",
  "lab",
  "labs",
  "production",
  "panel",
  "panels",
  "short",
  "student",
  "talk",
  "talks",
  "tutorial",
  "tutorials",
  "xr",
]);

const VENUE_DISAMBIGUATOR_WORDS = new Set([
  "asia",
  "europe",
  "european",
  "pacific",
  "regional",
]);

function significantVenueWords(value: unknown): string[] {
  return venueWords(value).filter(
    (word) =>
      !VENUE_PUBLISHER_WORDS.has(word) &&
      !/^sig[a-z0-9]+$/.test(word) &&
      !VENUE_GENERIC_WORDS.has(word) &&
      !VENUE_CONNECTOR_WORDS.has(word) &&
      !VENUE_ORDINAL_WORDS.has(word) &&
      !/^\d+$/.test(word) &&
      word !== "v" &&
      !/^(?:paper|papers|journal|transaction|transactions|volume|volumes)$/.test(
        word,
      ),
  );
}

export function isCrossrefVenueMatch(
  actualVenue: unknown,
  requestedVenue: unknown,
): boolean {
  const actual = normalizeVenue(actualVenue);
  const requested = normalizeVenue(requestedVenue);
  if (!actual || !requested) return false;
  const publicationJournalAliases: Readonly<Record<string, string>> = {
    pacmpl: "pacmpl",
    "proceedings of the acm on programming languages": "pacmpl",
    pacmse: "pacmse",
    "proceedings of the acm on software engineering": "pacmse",
    pacmmod: "pacmmod",
    "proceedings of the acm on management of data": "pacmmod",
  };
  const actualCanonical = publicationJournalAliases[actual] ?? actual;
  const requestedCanonical = publicationJournalAliases[requested] ?? requested;
  if (actualCanonical === requestedCanonical) return true;
  const actualText = str(actualVenue);
  const requestedText = str(requestedVenue);
  const actualParentheticalAcronym = actualText.match(
    /\(([A-Z][A-Z0-9-]{1,})\)\s*$/,
  )?.[1];
  if (
    actualParentheticalAcronym &&
    normalizeVenue(actualParentheticalAcronym).replace(/\s+/g, "") ===
      requested.replace(/\s+/g, "")
  ) {
    return true;
  }
  const actualWithoutParentheticalAcronym = normalizeVenue(
    actualText.replace(/\s*\([A-Z][A-Z0-9-]{1,}\)\s*$/, ""),
  );
  if (actualWithoutParentheticalAcronym === requested) return true;
  const requestedSigGroups = venueWords(requestedVenue).filter((word) =>
    /^sig[a-z0-9]+$/.test(word),
  );
  const actualWordSetWithGroups = new Set(venueWords(actualVenue));
  if (requestedSigGroups.some((group) => !actualWordSetWithGroups.has(group))) {
    return false;
  }
  const suffixIndex = actualText.indexOf(":");
  if (suffixIndex >= 0 && !requestedText.includes(":")) {
    const suffix = normalizeVenue(actualText.slice(suffixIndex + 1));
    if (suffix && !requested.includes(suffix)) return false;
  }
  const requestedWordSet = new Set(venueWords(requestedVenue));
  if (
    venueWords(actualVenue).some(
      (word) =>
        VENUE_DISAMBIGUATOR_WORDS.has(word) && !requestedWordSet.has(word),
    )
  ) {
    return false;
  }
  const actualQualifiers = venueWords(actualVenue).filter((word) =>
    VENUE_QUALIFIER_WORDS.has(word),
  );
  if (actualQualifiers.some((qualifier) => !requestedWordSet.has(qualifier))) {
    return false;
  }
  const acronym = queryAcronym(requestedVenue);
  if (actual === requested) {
    return true;
  }

  const requestedWords = significantVenueWords(requestedVenue);
  const requestedAcronyms = acronymCandidates(requestedVenue);
  const actualWords = significantVenueWords(actualVenue).filter(
    (word) => !requestedAcronyms.has(word) && !VENUE_ORDINAL_WORDS.has(word),
  );
  const actualWordSet = new Set(actualWords);
  if (
    requestedWords.length >= 1 &&
    requestedWords.every((word) => actualWordSet.has(word)) &&
    actualWords.every((word) => requestedWords.includes(word))
  ) {
    return true;
  }

  if (!acronym) return false;
  const escaped = acronym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (
    new RegExp(`(?:^|[\\s(/])${escaped.toUpperCase()}(?:$|[\\s),/:])`).test(
      str(actualVenue),
    )
  ) {
    return true;
  }
  return acronymCandidates(actualVenue).has(acronym);
}

const FRONT_MATTER_TITLE_PATTERNS = [
  /^(?:proceedings|conference proceedings)(?:\s|$)/i,
  /^(?:author|subject) index(?:\s|$)/i,
  /^(?:table of contents|contents|toc)$/i,
  /^(?:copyright|title) page(?:\s+[ivxlcdm\d]+)?$/i,
  /^(?:conference|organizing|organization|program|steering) committees?$/i,
  /^(?:organizers?|reviewers?|outstanding reviewers?)$/i,
  /^(?:message|welcome|preface|foreword|introduction)\s+(?:from|by|of)\s+(?:the\s+)?(?:general\s+|program\s+|conference\s+)?chairs?$/i,
  /^(?:general|program|conference) chairs?$/i,
  /^(?:pacm[a-z]*\s+)?(?:volume\s+\d+\s+issue\s+\d+|v\d+\s*,?\s*n\d+).*editorial$/i,
];

export function isCrossrefResearchContent(
  record: Pick<ScholarlyWorkRecord, "title" | "type">,
): boolean {
  const title = record.title.replace(/\s+/g, " ").trim();
  if (!title) return false;
  if (FRONT_MATTER_TITLE_PATTERNS.some((pattern) => pattern.test(title))) {
    return false;
  }
  return !new Set([
    "book",
    "book-series",
    "book-set",
    "component",
    "edited-book",
    "journal",
    "proceedings",
    "reference-book",
    "report-series",
  ]).has(record.type ?? "");
}

function maybeMailto(params: URLSearchParams): void {
  const mailto = process.env.CROSSREF_MAILTO?.trim();
  if (mailto) params.set("mailto", mailto);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reserveCrossrefRequest(): Promise<void> {
  const reservation = crossrefQueue.then(async () => {
    const delay = Math.max(0, nextCrossrefRequestAt - Date.now());
    if (delay > 0) await wait(delay);
    nextCrossrefRequestAt = Date.now() + CROSSREF_MIN_INTERVAL_MS;
  });
  crossrefQueue = reservation.catch(() => undefined);
  await reservation;
}

function retryAfterMs(response: Response): number {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return CROSSREF_MIN_INTERVAL_MS * 5;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
}

export async function fetchCrossref(
  path: string,
  label: string,
): Promise<unknown> {
  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await reserveCrossrefRequest();
      response = await fetch(`${API}${path}`, {
        headers: {
          Accept: "application/json",
          "User-Agent":
            "unicli-crossref/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
        },
        signal: AbortSignal.timeout(CROSSREF_TIMEOUT_MS),
      });
      if (response.status !== 429 || attempt > 0) break;
      await wait(Math.min(retryAfterMs(response), CROSSREF_MAX_RETRY_AFTER_MS));
    }
    if (!response) {
      throw crossrefError(
        "upstream_error",
        `${label} did not return a response.`,
        "Retry after the Crossref API is reachable and healthy.",
        { retryable: true },
      );
    }
    if (response.status === 404) {
      throw crossrefError(
        "empty_result",
        `${label} returned no result.`,
        "Verify the DOI or broaden the Crossref search query.",
      );
    }
    if (response.status === 429) {
      throw crossrefError(
        "rate_limited",
        `${label} returned HTTP 429.`,
        "Retry after the Crossref rate-limit window or reduce request frequency.",
        { retryable: true },
      );
    }
    if (!response.ok) {
      throw crossrefError(
        "upstream_error",
        `${label} returned HTTP ${response.status}.`,
        "Retry after the Crossref API is reachable and healthy.",
        { retryable: response.status >= 500 },
      );
    }
    return response.json();
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw crossrefError(
        "timeout",
        `${label} timed out after ${CROSSREF_TIMEOUT_MS} ms.`,
        "Retry later or select another scholarly source.",
        { retryable: true },
      );
    }
    if (
      error instanceof TypeError ||
      (error instanceof Error &&
        /fetch failed|network|socket/i.test(error.message))
    ) {
      throw crossrefError(
        "network_error",
        `${label} could not reach the Crossref API.`,
        "Retry after the Crossref API or local network is reachable.",
        { retryable: true },
      );
    }
    throw error;
  }
}

export function mapCrossrefItem(
  item: CrossrefItem,
  source: string,
): ScholarlyWorkRecord {
  const doi = requireCrossrefDoi(item.DOI);
  return {
    id: doi,
    title: arrFirst(item.title),
    authors: authors(item.author),
    year: year(item),
    date: date(item),
    venue: arrFirst(item["container-title"]) || undefined,
    volume: str(item.volume) || undefined,
    issue: str(item.issue) || undefined,
    type: str(item.type) || undefined,
    abstract: str(item.abstract).replace(/<[^>]+>/g, " ") || undefined,
    doi,
    cited_by_count: num(item["is-referenced-by-count"]),
    references_count: Array.isArray(item.reference)
      ? item.reference.length
      : undefined,
    pdf_url: pdfUrl(item),
    landing_url: str(item.URL) || `https://doi.org/${doi}`,
    source_adapter: source,
    source_url: str(item.URL) || `https://doi.org/${doi}`,
    retrieved_at: new Date().toISOString(),
    raw: {
      publisher: str(item.publisher) || undefined,
      member: str(item.member) || undefined,
      prefix: str(item.prefix) || undefined,
      volume: str(item.volume) || undefined,
      issue: str(item.issue) || undefined,
      license_urls: Array.isArray(item.license)
        ? item.license.map((entry) => str(entry.URL)).filter(Boolean)
        : undefined,
      relation: item.relation,
    },
  };
}

export async function searchCrossrefWorks(
  options: CrossrefSearchOptions,
  source: string,
): Promise<ScholarlyWorkRecord[]> {
  const requestedLimit = options.limit;
  const fetchLimit = options.containerTitle
    ? Math.min(Math.max(requestedLimit * 20, 250), 1_000)
    : requestedLimit;
  const params = new URLSearchParams({ rows: String(fetchLimit) });
  if (options.query) params.set("query.bibliographic", options.query);
  if (options.title) params.set("query.title", options.title);
  if (options.containerTitle)
    params.set("query.container-title", options.containerTitle);
  if (options.publisher) params.set("query.publisher-name", options.publisher);

  const filters: string[] = [];
  if (options.prefix) filters.push(`prefix:${options.prefix}`);
  if (options.issn) filters.push(`issn:${options.issn}`);
  if (options.year !== undefined) {
    filters.push(`from-pub-date:${options.year}-01-01`);
    filters.push(`until-pub-date:${options.year}-12-31`);
  }
  if (options.type) filters.push(`type:${options.type}`);
  if (filters.length > 0) params.set("filter", filters.join(","));
  maybeMailto(params);

  const body = (await fetchCrossref(
    `/works?${params.toString()}`,
    `${source} Crossref search`,
  )) as CrossrefWorksResponse;
  return (body.message?.items ?? [])
    .map((item) => mapCrossrefItem(item, source))
    .filter(
      (record) =>
        (options.year === undefined || record.year === options.year) &&
        (options.issues === undefined ||
          (record.issue !== undefined &&
            options.issues.some(
              (issue) => issue.toLowerCase() === record.issue?.toLowerCase(),
            ))) &&
        (options.volumeIssues === undefined ||
          options.volumeIssues.some(
            (pair) =>
              pair.volume.toLowerCase() === record.volume?.toLowerCase() &&
              pair.issue.toLowerCase() === record.issue?.toLowerCase(),
          )) &&
        (options.containerTitle === undefined ||
          [options.containerTitle, ...(options.venueAliases ?? [])].some(
            (venue) => isCrossrefVenueMatch(record.venue, venue),
          )) &&
        (!options.researchContentOnly || isCrossrefResearchContent(record)),
    )
    .slice(0, requestedLimit);
}

export async function getCrossrefWork(
  doiValue: unknown,
  source: string,
): Promise<ScholarlyWorkRecord> {
  const doi = requireCrossrefDoi(doiValue);
  const params = new URLSearchParams();
  maybeMailto(params);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const body = (await fetchCrossref(
    `/works/${encodeURIComponent(doi)}${suffix}`,
    `${source} Crossref work ${doi}`,
  )) as CrossrefWorkResponse;
  if (!body.message) {
    throw crossrefError(
      "empty_result",
      `Crossref returned no work for ${doi}.`,
      "Verify the DOI or search by title.",
      { alternatives: ["unicli scholar search <title>"] },
    );
  }
  return mapCrossrefItem(body.message, source);
}
