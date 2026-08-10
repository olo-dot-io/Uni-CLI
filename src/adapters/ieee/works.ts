/**
 * @owner       src::adapters::ieee::works
 * @does        Registers keyless IEEE publication search, conference browse, and DOI lookup through IEEE's Crossref deposits.
 * @needs       src/adapters/_shared/crossref.ts, Crossref prefix 10.1109
 * @feeds       src/commands/scholar.ts via scholar.search, scholar.get, and scholar.venue
 * @breaks      Missing IEEE Crossref deposits, metadata drift, or rate limiting surfaces as explicit adapter errors.
 * @invariants  Every returned record has DOI prefix 10.1109 and preserves IEEE source provenance.
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

export const IEEE_DOI_PREFIX = "10.1109";

function optionalYear(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1963 || year > 2100) {
    throw new Error(`ieee year must be an integer in [1963, 2100].`);
  }
  return year;
}

function limit(value: unknown): number {
  const result = Number(value ?? 20);
  if (!Number.isInteger(result) || result < 1 || result > 100) {
    throw new Error("ieee limit must be an integer in [1, 100].");
  }
  return result;
}

function requireText(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`ieee ${label} cannot be empty.`);
  return text;
}

function embeddedYear(value: string): number | undefined {
  const match = value.match(/\b(?:19|20)\d{2}\b/);
  return match ? Number(match[0]) : undefined;
}

interface IeeeVenueQuery {
  containerTitle: string;
  aliases: string[];
}

export function resolveIeeeVenueQuery(value: string): IeeeVenueQuery {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
  if (
    normalized === "aspdac" ||
    normalized === "asiaandsouthpacificdesignautomationconference"
  ) {
    return {
      containerTitle: "Asia and South Pacific Design Automation Conference",
      aliases: ["ASP-DAC", value],
    };
  }
  return { containerTitle: value, aliases: [value] };
}

cli({
  site: "ieee",
  name: "search",
  description:
    "Search IEEE publications from official DOI registration metadata without an API key",
  domain: "api.crossref.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "venue", type: "str" },
    { name: "year", type: "int", minimum: 1963, maximum: 2100 },
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
    const explicitConference = explicitVenue
      ? resolveCcfConference(explicitVenue)
      : undefined;
    const inferredConference = explicitConference
      ? undefined
      : findCcfConferenceInText(query);
    const conference = explicitConference ?? inferredConference;
    const directVenue =
      explicitVenue && !conference
        ? resolveIeeeVenueQuery(explicitVenue)
        : undefined;
    const rows = await searchCrossrefWorks(
      {
        query: inferredConference
          ? ccfResidualSearchQuery(query, inferredConference)
          : query,
        containerTitle: conference
          ? ccfCrossrefContainerQuery(conference)
          : directVenue?.containerTitle,
        venueAliases: conference
          ? [conference.name, ...ccfConferenceIdentities(conference)]
          : directVenue?.aliases,
        prefix: IEEE_DOI_PREFIX,
        year: optionalYear(kwargs.year) ?? embeddedYear(query),
        researchContentOnly: true,
        limit: limit(kwargs.limit),
      },
      "ieee",
    );
    if (rows.length === 0) {
      throw crossrefEmptyResult(`No IEEE publications matched "${query}".`, [
        `unicli scholar search ${JSON.stringify(query)}`,
      ]);
    }
    return rows;
  },
});

cli({
  site: "ieee",
  name: "venue",
  description: "List IEEE conference proceedings papers without an API key",
  domain: "api.crossref.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "venue", type: "str", required: true, positional: true },
    { name: "year", type: "int", minimum: 1963, maximum: 2100 },
    { name: "limit", type: "int", default: 50, minimum: 1, maximum: 100 },
  ],
  columns: ["id", "title", "authors", "year", "venue", "doi", "source_url"],
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "list",
  capabilities: ["http.fetch", "scholar.venue"],
  func: async (_page, kwargs) => {
    const venue = requireText(kwargs.venue, "venue");
    const conference = resolveCcfConference(venue);
    const directVenue = conference ? undefined : resolveIeeeVenueQuery(venue);
    const rows = await searchCrossrefWorks(
      {
        containerTitle: conference
          ? ccfCrossrefContainerQuery(conference)
          : directVenue!.containerTitle,
        venueAliases: conference
          ? [conference.name, ...ccfConferenceIdentities(conference), venue]
          : directVenue!.aliases,
        prefix: IEEE_DOI_PREFIX,
        type: "proceedings-article",
        year: optionalYear(kwargs.year),
        researchContentOnly: true,
        limit: limit(kwargs.limit),
      },
      "ieee",
    );
    if (rows.length === 0) {
      throw crossrefEmptyResult(
        `No IEEE conference papers matched "${venue}".`,
        [`unicli scholar venue ${JSON.stringify(venue)}`],
      );
    }
    return rows;
  },
});

cli({
  site: "ieee",
  name: "paper",
  description: "Fetch one IEEE publication by DOI without an API key",
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
      IEEE_DOI_PREFIX,
      "ieee",
    );
    return [await getCrossrefWork(doi, "ieee")];
  },
});
