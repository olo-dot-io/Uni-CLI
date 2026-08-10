/**
 * @owner       src::adapters::ccf::directory
 * @does        Registers exact and filtered lookup over the official seventh-edition CCF A-class international conference directory.
 * @needs       src/adapters/ccf/directory-data.ts, CCF formal directory PDF identity
 * @feeds       Direct CCF A conference classification lookup and scholarly command discovery
 * @breaks      A new formal CCF directory edition requires replacing the versioned records and their source identity together.
 * @invariants  Every row comes from the 2026 seventh-edition formal PDF updated 2026-04-09; stale category HTML is never treated as current directory truth.
 * @side-effects none
 * @perf        O(58) filtering and ranking
 * @concurrency safe
 * @test        tests/unit/adapters/ccf-directory.test.ts
 * @stability   experimental
 * @since       2026-08-09
 */

import { cli, Strategy } from "../../registry.js";
import type { ScholarlyContextRecord } from "../../types/scholarly.js";
import {
  CCF_A_CONFERENCES,
  type CcfConferenceRecord,
} from "./directory-data.js";
export { findCcfConferenceInText, resolveCcfConference } from "./resolve.js";

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function normalize(value: unknown): string {
  return text(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\p{Script=Han}]+/gu, " ")
    .trim();
}

function compact(value: unknown): string {
  return normalize(value).replace(/\s+/g, "");
}

function queryTerms(value: unknown): string[] {
  return normalize(value).split(/\s+/).filter(Boolean);
}

function boundedLimit(value: unknown, fallback: number): number {
  const raw =
    value === undefined || value === null || value === "" ? fallback : value;
  const limit = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("ccf limit must be an integer in [1, 100].");
  }
  return limit;
}

function noMatchError(message: string): Error {
  return Object.assign(new Error(message), {
    code: "empty_result",
    suggestion:
      "Try an acronym, former name, full conference name, category, or publisher from the 2026 seventh edition.",
    retryable: false,
    alternatives: ["unicli ccf conferences"],
  });
}

function isDirectoryWideQuery(value: string): boolean {
  const key = compact(value);
  return ["ccf", "ccfa", "ccfa类", "ccfa类会议", "a类", "a类会议"].includes(
    key,
  );
}

export function scoreCcfConference(
  record: CcfConferenceRecord,
  queryValue: unknown,
): number {
  const query = text(queryValue);
  if (!query || isDirectoryWideQuery(query)) return 1;
  const target = compact(query);
  const acronym = compact(record.acronym);
  const aliases = record.aliases.map(compact);
  if (target === acronym) return 100;
  if (aliases.includes(target)) return 98;
  const name = normalize(record.name);
  const category = normalize(record.category);
  const normalizedQuery = normalize(query);
  if (name === normalizedQuery) return 95;
  if (name.includes(normalizedQuery)) return 85;
  if (category.includes(normalizedQuery)) return 75;
  const haystack = normalize(
    [
      record.acronym,
      record.aliases.join(" "),
      record.name,
      record.category,
      record.publisher,
    ].join(" "),
  );
  const terms = queryTerms(query).filter(
    (term) => !["ccf", "ccfa", "conference", "会议", "a", "类"].includes(term),
  );
  if (terms.length === 0) return 1;
  const matched = terms.filter((term) => haystack.includes(term)).length;
  return matched === terms.length ? 60 + matched : 0;
}

export function mapCcfConference(
  record: CcfConferenceRecord,
): ScholarlyContextRecord & Record<string, unknown> {
  return {
    id: `ccf-7-a-${compact(record.acronym)}`,
    title: record.name,
    relation: "official-conference",
    year: record.directory_year,
    venue: record.acronym,
    type: "conference-ranking",
    landing_url: record.official_venue_url,
    source_adapter: "ccf",
    source_url: record.source_url,
    retrieved_at: new Date().toISOString(),
    acronym: record.acronym,
    aliases: record.aliases,
    rank: record.rank,
    category: record.category,
    publisher: record.publisher,
    edition: record.edition,
    directory_year: record.directory_year,
    directory_updated: record.updated,
    official_venue_url: record.official_venue_url,
    pdf_page: record.pdf_page,
    raw: {
      acronym: record.acronym,
      aliases: record.aliases,
      category: record.category,
      publisher: record.publisher,
    },
  };
}

export function findCcfConferences(options: {
  query?: unknown;
  category?: unknown;
  publisher?: unknown;
  limit?: unknown;
}): Array<ScholarlyContextRecord & Record<string, unknown>> {
  const query = text(options.query);
  const category = normalize(options.category);
  const publisher = normalize(options.publisher);
  const limit = boundedLimit(options.limit, query ? 20 : 100);
  return CCF_A_CONFERENCES.map((record) => ({
    record,
    score: scoreCcfConference(record, query),
  }))
    .filter(({ record, score }) => {
      if (score === 0) return false;
      if (category && !normalize(record.category).includes(category))
        return false;
      if (publisher && !normalize(record.publisher).includes(publisher))
        return false;
      return true;
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.record.category.localeCompare(right.record.category, "zh-CN") ||
        left.record.acronym.localeCompare(right.record.acronym),
    )
    .slice(0, limit)
    .map(({ record }) => mapCcfConference(record));
}

const columns = [
  "acronym",
  "aliases",
  "title",
  "rank",
  "category",
  "publisher",
  "edition",
  "directory_year",
  "directory_updated",
  "official_venue_url",
  "source_url",
  "pdf_page",
];

cli({
  site: "ccf",
  name: "conferences",
  description:
    "List and filter all 58 official CCF A-class conferences from the 2026 seventh edition",
  domain: "www.ccf.org.cn",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "query", type: "str", positional: true },
    { name: "category", type: "str" },
    { name: "publisher", type: "str" },
    { name: "limit", type: "int", default: 100, minimum: 1, maximum: 100 },
  ],
  columns,
  operation_effect: "read",
  execution_operator: "local-runtime",
  operation_family: "list",
  capabilities: ["scholar.venue"],
  func: async (_page, kwargs) => {
    const rows = findCcfConferences(kwargs);
    if (rows.length === 0) {
      throw noMatchError(
        "CCF seventh-edition directory returned no matching A-class conference.",
      );
    }
    return rows;
  },
});

cli({
  site: "ccf",
  name: "conference",
  description:
    "Resolve one CCF A-class conference by acronym, former name, alias, or full name",
  domain: "www.ccf.org.cn",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 20, minimum: 1, maximum: 100 },
  ],
  columns,
  operation_effect: "read",
  execution_operator: "local-runtime",
  operation_family: "get",
  capabilities: ["scholar.venue"],
  func: async (_page, kwargs) => {
    const query = text(kwargs.query);
    if (!query) throw new Error("ccf conference query cannot be empty.");
    const rows = findCcfConferences({ query, limit: kwargs.limit });
    if (rows.length === 0) {
      throw noMatchError(`No CCF A-class conference matched "${query}".`);
    }
    return rows;
  },
});
