/**
 * @owner       src::adapters::crossref::works
 * @does        Registers Crossref REST work search and DOI lookup commands for publisher metadata.
 * @needs       src/adapters/_shared/crossref.ts, api.crossref.org REST API, src/registry.ts
 * @feeds       src/commands/scholar.ts and registry-driven AI literature intelligence through scholar.* and ai.* capabilities
 * @breaks      Crossref response-shape drift or rate limiting surfaces as explicit adapter errors.
 * @invariants  DOI lookup accepts only DOI-shaped references; output maps to ScholarlyWorkRecord.
 * @side-effects HTTPS egress to api.crossref.org only
 * @perf        O(limit) JSON mapping
 * @concurrency safe
 * @test        tests/unit/adapters/scholar-sources.test.ts
 * @stability   experimental
 * @since       2026-05-19
 */

import { cli, Strategy } from "../../registry.js";
import {
  crossrefEmptyResult,
  getCrossrefWork,
  requireCrossrefDoi,
  searchCrossrefWorks,
} from "../_shared/crossref.js";
import {
  ccfConferenceIdentities,
  ccfCrossrefContainerQuery,
  resolveCcfConference,
} from "../ccf/resolve.js";

export { mapCrossrefItem, requireCrossrefDoi } from "../_shared/crossref.js";
export type { CrossrefItem } from "../_shared/crossref.js";

export function requireCrossrefSearchQuery(value: unknown): string {
  const query = String(value ?? "").trim();
  if (!query) {
    throw Object.assign(new Error("crossref search query cannot be empty."), {
      code: "invalid_input",
      suggestion: "Provide a paper title, author, DOI, or bibliographic query.",
    });
  }
  return query;
}

export function requireCrossrefSearchRows<T>(rows: T[], query: string): T[] {
  if (rows.length === 0) {
    throw crossrefEmptyResult(`No Crossref works matched "${query}".`);
  }
  return rows;
}

cli({
  site: "crossref",
  name: "search",
  description:
    "Search Crossref Works by title, author, DOI, or bibliographic text",
  domain: "api.crossref.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 20, minimum: 1, maximum: 100 },
  ],
  columns: ["id", "title", "authors", "year", "venue", "doi", "source_url"],
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "search",
  retrieval: {
    operation: "discover",
    result_kind: "paper",
    source_class: "hosted-artifact",
    arguments: { query: "query", limit: "limit" },
  },
  capabilities: ["http.fetch", "scholar.search"],
  func: async (_page, kwargs) => {
    const query = requireCrossrefSearchQuery(kwargs.query);
    const limit = Number(kwargs.limit ?? 20);
    return requireCrossrefSearchRows(
      await searchCrossrefWorks({ query, limit }, "crossref"),
      query,
    );
  },
});

cli({
  site: "crossref",
  name: "work",
  description: "Fetch one Crossref Work by DOI",
  domain: "api.crossref.org",
  strategy: Strategy.PUBLIC,
  args: [{ name: "doi", type: "str", required: true, positional: true }],
  columns: ["id", "title", "authors", "year", "venue", "doi", "source_url"],
  capabilities: ["http.fetch", "scholar.get"],
  func: async (_page, kwargs) => {
    const doi = requireCrossrefDoi(kwargs.doi ?? kwargs.id ?? kwargs.ref);
    return [await getCrossrefWork(doi, "crossref")];
  },
});

cli({
  site: "crossref",
  name: "venue",
  description:
    "List venue papers from Crossref registration metadata across publishers",
  domain: "api.crossref.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "venue", type: "str", required: true, positional: true },
    { name: "year", type: "int", minimum: 1800, maximum: 2100 },
    { name: "limit", type: "int", default: 50, minimum: 1, maximum: 100 },
  ],
  columns: ["id", "title", "authors", "year", "venue", "doi", "source_url"],
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "list",
  capabilities: ["http.fetch", "scholar.venue"],
  func: async (_page, kwargs) => {
    const venue = requireCrossrefSearchQuery(kwargs.venue);
    const conference = resolveCcfConference(venue);
    const year =
      kwargs.year === undefined || kwargs.year === null || kwargs.year === ""
        ? undefined
        : Number(kwargs.year);
    const limit = Number(kwargs.limit ?? 50);
    return requireCrossrefSearchRows(
      await searchCrossrefWorks(
        {
          containerTitle: conference
            ? ccfCrossrefContainerQuery(conference)
            : venue,
          venueAliases: conference
            ? [conference.name, ...ccfConferenceIdentities(conference), venue]
            : [venue],
          year,
          researchContentOnly: true,
          limit,
        },
        "crossref",
      ),
      `${venue}${year ? ` ${year}` : ""}`,
    );
  },
});
