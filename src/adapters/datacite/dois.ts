/**
 * @owner       src::adapters::datacite::dois
 * @does        Registers DataCite DOI search, lookup, and related research-object discovery for datasets and software.
 * @needs       api.datacite.org public REST API
 * @feeds       Scholar metadata and dataset/software resource discovery
 * @breaks      DataCite API or schema drift surfaces as explicit adapter errors.
 * @invariants  DOI provenance remains DataCite; related-resource results retain relation metadata and resource types.
 * @side-effects HTTPS egress to api.datacite.org
 * @perf        O(page size) JSON mapping, one request per invocation
 * @concurrency safe
 * @test        tests/unit/adapters/scholar-publishers.test.ts
 * @stability   experimental
 * @since       2026-08-09
 */

import { cli, Strategy } from "../../registry.js";
import type { ScholarlyWorkRecord } from "../../types/scholarly.js";

const API = "https://api.datacite.org";

interface DataCiteCreator {
  name?: unknown;
  givenName?: unknown;
  familyName?: unknown;
  nameIdentifiers?: unknown;
  affiliation?: unknown;
}

export interface DataCiteAttributes {
  doi?: unknown;
  titles?: Array<{ title?: unknown }>;
  creators?: DataCiteCreator[];
  publicationYear?: unknown;
  published?: unknown;
  publisher?: unknown;
  types?: {
    resourceType?: unknown;
    resourceTypeGeneral?: unknown;
  };
  descriptions?: Array<{ description?: unknown; descriptionType?: unknown }>;
  url?: unknown;
  relatedIdentifiers?: unknown;
  subjects?: unknown;
  rightsList?: unknown;
  container?: { title?: unknown };
  version?: unknown;
  fundingReferences?: unknown;
}

export interface DataCiteResource {
  id?: unknown;
  attributes?: DataCiteAttributes;
}

interface DataCiteEnvelope {
  data?: DataCiteResource[] | DataCiteResource;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function year(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const result = typeof value === "number" ? value : Number(value);
  return Number.isInteger(result) ? result : undefined;
}

function requireDoi(value: unknown): string {
  const doi = text(value)
    .replace(/^doi:/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
  if (!/^10\.\S+\/\S+$/i.test(doi)) {
    throw new Error(`datacite DOI "${String(value ?? "")}" is not recognised.`);
  }
  return doi;
}

function limit(value: unknown): number {
  const result = value === undefined ? 20 : Number(value);
  if (!Number.isInteger(result) || result < 1 || result > 1000) {
    throw new Error("datacite limit must be an integer in [1, 1000].");
  }
  return result;
}

export function mapDataCiteResource(
  resource: DataCiteResource,
): ScholarlyWorkRecord {
  const attributes = resource.attributes ?? {};
  const doi = requireDoi(attributes.doi ?? resource.id);
  const resourceType = text(
    attributes.types?.resourceTypeGeneral,
  ).toLowerCase();
  const url = text(attributes.url) || `https://doi.org/${doi}`;
  const authors = (attributes.creators ?? [])
    .map(
      (creator) =>
        text(creator.name) ||
        [creator.givenName, creator.familyName]
          .map(text)
          .filter(Boolean)
          .join(" "),
    )
    .filter(Boolean);
  const descriptions = (attributes.descriptions ?? [])
    .map((entry) => text(entry.description))
    .filter(Boolean);
  const title = text(attributes.titles?.[0]?.title);
  return {
    id: doi,
    title,
    authors: authors.length > 0 ? authors : undefined,
    year: year(attributes.publicationYear),
    date: text(attributes.published) || undefined,
    venue:
      text(attributes.container?.title) ||
      text(attributes.publisher) ||
      undefined,
    type:
      text(attributes.types?.resourceType) ||
      text(attributes.types?.resourceTypeGeneral) ||
      undefined,
    abstract: descriptions.join("\n\n") || undefined,
    doi,
    landing_url: url,
    code_url: resourceType === "software" ? url : undefined,
    dataset_url: resourceType === "dataset" ? url : undefined,
    source_adapter: "datacite",
    source_url: `https://api.datacite.org/dois/${encodeURIComponent(doi)}`,
    retrieved_at: new Date().toISOString(),
    raw: {
      publisher: text(attributes.publisher) || undefined,
      resource_type_general:
        text(attributes.types?.resourceTypeGeneral) || undefined,
      related_identifiers: attributes.relatedIdentifiers,
      subjects: attributes.subjects,
      rights: attributes.rightsList,
      version: text(attributes.version) || undefined,
      funding_references: attributes.fundingReferences,
    },
  };
}

async function requestDataCite(
  path: string,
  label: string,
): Promise<ScholarlyWorkRecord[]> {
  const response = await fetch(`${API}${path}`, {
    headers: { Accept: "application/vnd.api+json" },
  });
  if (response.status === 404) throw new Error(`${label} returned no result.`);
  if (response.status === 429) {
    const error = new Error(`${label} returned HTTP 429.`) as Error & {
      code: string;
    };
    error.code = "rate_limited";
    throw error;
  }
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}.`);
  const envelope = (await response.json()) as DataCiteEnvelope;
  const data = Array.isArray(envelope.data)
    ? envelope.data
    : envelope.data
      ? [envelope.data]
      : [];
  return data.map(mapDataCiteResource);
}

const columns = [
  "id",
  "title",
  "authors",
  "year",
  "venue",
  "type",
  "doi",
  "code_url",
  "dataset_url",
  "landing_url",
  "source_url",
];

cli({
  site: "datacite",
  name: "search",
  description:
    "Search DataCite research objects including datasets and software",
  domain: "api.datacite.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "type", type: "str" },
    { name: "year", type: "int", minimum: 1900, maximum: 2100 },
    { name: "limit", type: "int", default: 20, minimum: 1, maximum: 1000 },
  ],
  columns,
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "search",
  retrieval: {
    operation: "discover",
    result_kind: "scholarly-work",
    source_class: "official",
    arguments: { query: "query", limit: "limit" },
  },
  capabilities: ["http.fetch", "scholar.search"],
  func: async (_page, kwargs) => {
    const query = text(kwargs.query);
    if (!query) throw new Error("datacite search query cannot be empty.");
    const params = new URLSearchParams({
      query,
      "page[size]": String(limit(kwargs.limit)),
    });
    const filters = [
      text(kwargs.type) ? `types.resourceTypeGeneral:${text(kwargs.type)}` : "",
      kwargs.year ? `publicationYear:${String(kwargs.year)}` : "",
    ].filter(Boolean);
    if (filters.length > 0) params.set("filter", filters.join(","));
    const rows = await requestDataCite(
      `/dois?${params.toString()}`,
      "DataCite search",
    );
    if (rows.length === 0)
      throw new Error(`No DataCite records matched "${query}".`);
    return rows;
  },
});

cli({
  site: "datacite",
  name: "doi",
  description: "Fetch one DataCite research object by DOI",
  domain: "api.datacite.org",
  strategy: Strategy.PUBLIC,
  args: [{ name: "doi", type: "str", required: true, positional: true }],
  columns,
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "get",
  capabilities: ["http.fetch", "scholar.get"],
  func: async (_page, kwargs) => {
    const doi = requireDoi(kwargs.doi ?? kwargs.id ?? kwargs.ref);
    return requestDataCite(
      `/dois/${encodeURIComponent(doi)}`,
      `DataCite DOI ${doi}`,
    );
  },
});

cli({
  site: "datacite",
  name: "related",
  description: "Find DataCite datasets and software related to a paper DOI",
  domain: "api.datacite.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "doi", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 50, minimum: 1, maximum: 1000 },
  ],
  columns,
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "search",
  capabilities: ["http.fetch", "scholar.datasets", "scholar.code"],
  func: async (_page, kwargs) => {
    const doi = requireDoi(kwargs.doi ?? kwargs.id ?? kwargs.ref);
    const params = new URLSearchParams({
      query: `relatedIdentifiers.relatedIdentifier:${JSON.stringify(doi)}`,
      "page[size]": String(limit(kwargs.limit)),
    });
    const rows = await requestDataCite(
      `/dois?${params.toString()}`,
      `DataCite resources related to ${doi}`,
    );
    if (rows.length === 0)
      throw new Error(`DataCite returned no resources related to ${doi}.`);
    return rows;
  },
});
