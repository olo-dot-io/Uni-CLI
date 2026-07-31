/**
 * @owner       src::adapters::archive
 * @does        Registers structured Internet Archive metadata/search and Wayback snapshot lookup commands.
 * @needs       archive.org metadata/advanced-search/availability APIs and web.archive.org CDX
 * @feeds       reference research, historical web retrieval, and current OpenCLI surface parity
 * @breaks      Malformed identifiers, timestamps, API envelopes, or missing stable result identities fail explicitly.
 * @invariants  All commands are read-only structured HTTP operations; no browser provider is acquired.
 * @side-effects HTTPS/HTTP egress to Internet Archive public endpoints.
 * @perf        O(limit) validation and row projection; limits are bounded before network acquisition.
 * @concurrency Stateless and safe across invocations.
 * @test        src/adapters/archive/archive.test.ts
 * @stability   stable
 * @since       2026-07-31
 */

import { cli, Strategy } from "../../registry.js";

const IDENTIFIER_RE = /^[A-Za-z0-9._-]+$/;
const TIMESTAMP_RE = /^\d{4}(?:\d{2}){0,5}$/;
const SEARCH_SORTS = ["downloads", "date", "addeddate", "week", "title"];
const SEARCH_MEDIATYPES = [
  "texts",
  "movies",
  "audio",
  "software",
  "image",
  "web",
  "data",
  "collection",
];

type ArchiveErrorCode = "invalid_input" | "empty_result" | "upstream_error";

function archiveError(
  code: ArchiveErrorCode,
  message: string,
  suggestion: string,
): Error {
  return Object.assign(new Error(message), {
    code,
    suggestion,
    retryable: code === "upstream_error",
    alternatives: [] as string[],
  });
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function joinedString(value: unknown, separator: string): string {
  return Array.isArray(value)
    ? value
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean)
        .join(separator)
    : String(value ?? "").trim();
}

export function requireArchiveIdentifier(value: unknown): string {
  const identifier = String(value ?? "").trim();
  if (!IDENTIFIER_RE.test(identifier)) {
    throw archiveError(
      "invalid_input",
      `archive identifier ${JSON.stringify(identifier)} is invalid`,
      "Use an Internet Archive identifier containing only letters, digits, dot, underscore, or hyphen.",
    );
  }
  return identifier;
}

export function requireArchiveLimit(
  value: unknown,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const limit =
    value === undefined || value === null ? fallback : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw archiveError(
      "invalid_input",
      `${label} must be an integer in [1, ${String(maximum)}]`,
      `Choose a bounded ${label} value and retry.`,
    );
  }
  return limit;
}

export function normalizeArchiveTimestamp(value: unknown): string {
  const digits = String(value ?? "").replace(/[^0-9]/g, "");
  if (!TIMESTAMP_RE.test(digits)) {
    throw archiveError(
      "invalid_input",
      "archive timestamp must be YYYY[MM[DD[hh[mm[ss]]]]] or an ISO date",
      "Use an even-length 4–14 digit timestamp or an ISO date.",
    );
  }
  return digits;
}

export function mapArchiveItem(
  expectedIdentifier: string,
  payload: unknown,
): Record<string, unknown> {
  const body = objectValue(payload);
  const metadata = objectValue(body.metadata);
  const identifier = stringValue(metadata.identifier);
  if (!identifier) {
    throw archiveError(
      "empty_result",
      `No public Internet Archive metadata exists for ${expectedIdentifier}.`,
      "Verify the identifier or search Internet Archive first.",
    );
  }
  if (!IDENTIFIER_RE.test(identifier) || identifier !== expectedIdentifier) {
    throw archiveError(
      "upstream_error",
      "Internet Archive returned metadata for an unexpected identifier.",
      "Retry the exact identifier after the upstream metadata response stabilizes.",
    );
  }
  if (!Array.isArray(body.files)) {
    throw archiveError(
      "upstream_error",
      "Internet Archive metadata omitted its files array.",
      "Retry after the upstream metadata schema is available.",
    );
  }
  return {
    identifier,
    title: stringValue(metadata.title),
    creator: joinedString(metadata.creator, ", "),
    date: stringValue(metadata.date).slice(0, 10),
    mediatype: stringValue(metadata.mediatype),
    collection: joinedString(metadata.collection, ", "),
    description: joinedString(metadata.description, " "),
    file_count: body.files.length,
    url: `https://archive.org/details/${identifier}`,
  };
}

export function mapArchiveSearchRows(
  payload: unknown,
  limit: number,
): Array<Record<string, unknown>> {
  const response = objectValue(objectValue(payload).response);
  if (!Array.isArray(response.docs)) {
    throw archiveError(
      "upstream_error",
      "Internet Archive search omitted response.docs.",
      "Retry after the advanced-search schema is available.",
    );
  }
  if (response.docs.length === 0) {
    throw archiveError(
      "empty_result",
      "Internet Archive search returned no matching items.",
      "Broaden the query or remove the mediatype constraint.",
    );
  }
  return response.docs.slice(0, limit).map((raw, index) => {
    const row = objectValue(raw);
    const identifier = stringValue(row.identifier);
    if (!IDENTIFIER_RE.test(identifier)) {
      throw archiveError(
        "upstream_error",
        "Internet Archive search returned a row without a stable identifier.",
        "Retry after the upstream index row is repaired.",
      );
    }
    const downloads = Number(row.downloads ?? 0);
    if (!Number.isFinite(downloads)) {
      throw archiveError(
        "upstream_error",
        `Internet Archive search returned non-numeric downloads for ${identifier}.`,
        "Retry after the upstream index row is repaired.",
      );
    }
    return {
      rank: index + 1,
      identifier,
      title: stringValue(row.title),
      creator: joinedString(row.creator, ", "),
      date: stringValue(row.date).slice(0, 10),
      mediatype: stringValue(row.mediatype),
      downloads,
      url: `https://archive.org/details/${identifier}`,
    };
  });
}

function requiredCdxColumn(columns: Map<string, number>, name: string): number {
  const index = columns.get(name);
  if (index === undefined) {
    throw archiveError(
      "upstream_error",
      `Wayback CDX response omitted the ${name} column.`,
      "Retry after the upstream CDX schema is available.",
    );
  }
  return index;
}

export function mapArchiveSnapshotRows(
  payload: unknown,
  limit: number,
): Array<Record<string, unknown>> {
  if (!Array.isArray(payload)) {
    throw archiveError(
      "upstream_error",
      "Wayback CDX response must be an array.",
      "Retry after the upstream CDX response stabilizes.",
    );
  }
  if (payload.length < 2) {
    throw archiveError(
      "empty_result",
      "Wayback CDX returned no snapshots.",
      "Verify the URL or broaden the requested time range.",
    );
  }
  const [header, ...rows] = payload;
  if (!Array.isArray(header)) {
    throw archiveError(
      "upstream_error",
      "Wayback CDX response omitted its header row.",
      "Retry after the upstream CDX response stabilizes.",
    );
  }
  const columns = new Map(
    header.map((name, index) => [String(name), index] as const),
  );
  const timestampIndex = requiredCdxColumn(columns, "timestamp");
  const originalIndex = requiredCdxColumn(columns, "original");
  const statusIndex = requiredCdxColumn(columns, "statuscode");
  const mimeIndex = requiredCdxColumn(columns, "mimetype");

  return rows.slice(0, limit).map((raw) => {
    if (!Array.isArray(raw)) {
      throw archiveError(
        "upstream_error",
        "Wayback CDX returned a non-array snapshot row.",
        "Retry after the upstream CDX response stabilizes.",
      );
    }
    const timestamp = String(raw[timestampIndex] ?? "");
    const originalUrl = String(raw[originalIndex] ?? "");
    const status = String(raw[statusIndex] ?? "");
    const mimetype = String(raw[mimeIndex] ?? "");
    if (!/^\d{14}$/.test(timestamp) || !originalUrl || !status || !mimetype) {
      throw archiveError(
        "upstream_error",
        "Wayback CDX returned an incomplete snapshot row.",
        "Retry after the upstream CDX index row is repaired.",
      );
    }
    return {
      timestamp,
      snapshot_url: `https://web.archive.org/web/${timestamp}/${originalUrl}`,
      status,
      mimetype,
      original_url: originalUrl,
    };
  });
}

export function mapArchiveWaybackRow(
  payload: unknown,
  target: string,
  requestedTimestamp: string,
): Record<string, unknown> {
  const body = objectValue(payload);
  const closest = objectValue(objectValue(body.archived_snapshots).closest);
  if (closest.available !== true) {
    throw archiveError(
      "empty_result",
      `No Wayback snapshot exists for ${target}.`,
      "Verify the URL or choose another timestamp.",
    );
  }
  const snapshotTimestamp = stringValue(closest.timestamp);
  const snapshotUrl = stringValue(closest.url);
  if (!/^\d{14}$/.test(snapshotTimestamp) || !snapshotUrl) {
    throw archiveError(
      "upstream_error",
      "Wayback availability response omitted the closest snapshot identity.",
      "Retry after the upstream availability response stabilizes.",
    );
  }
  return {
    original_url: stringValue(body.url) || target,
    requested_timestamp: requestedTimestamp,
    snapshot_timestamp: snapshotTimestamp,
    snapshot_url: snapshotUrl,
    status: String(closest.status ?? ""),
  };
}

async function fetchArchiveJson(
  url: URL | string,
  label: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "unicli-archive (https://github.com/olo-dot-io/Uni-CLI)",
      },
    });
  } catch (cause) {
    throw archiveError(
      "upstream_error",
      `${label} request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      "Check network reachability and retry the same structured Archive operation.",
    );
  }
  if (!response.ok) {
    throw archiveError(
      "upstream_error",
      `${label} returned HTTP ${String(response.status)}.`,
      "Retry after the Internet Archive endpoint recovers.",
    );
  }
  try {
    return await response.json();
  } catch (cause) {
    throw archiveError(
      "upstream_error",
      `${label} returned malformed JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      "Retry after the Internet Archive endpoint returns valid JSON.",
    );
  }
}

const READ_CONTRACT = {
  operation_effect: "read" as const,
  execution_operator: "structured-api" as const,
  idempotency: "guaranteed" as const,
  capabilities: ["http.fetch"],
  minimum_capability: "http.fetch",
};

cli({
  site: "archive",
  name: "item",
  description: "Fetch public Internet Archive item metadata by identifier",
  domain: "archive.org",
  strategy: Strategy.PUBLIC,
  operation_family: "get",
  ...READ_CONTRACT,
  args: [
    {
      name: "identifier",
      type: "str",
      required: true,
      positional: true,
      pattern: "^[A-Za-z0-9._-]+$",
      description: "Internet Archive item identifier",
    },
  ],
  columns: [
    "identifier",
    "title",
    "creator",
    "date",
    "mediatype",
    "collection",
    "description",
    "file_count",
    "url",
  ],
  func: async (_page, kwargs) => {
    const identifier = requireArchiveIdentifier(kwargs.identifier);
    return [
      mapArchiveItem(
        identifier,
        await fetchArchiveJson(
          `https://archive.org/metadata/${encodeURIComponent(identifier)}`,
          "archive item",
        ),
      ),
    ];
  },
});

cli({
  site: "archive",
  name: "search",
  description:
    "Search public Internet Archive books, movies, audio, software, web, and data",
  domain: "archive.org",
  strategy: Strategy.PUBLIC,
  operation_family: "search",
  retrieval: {
    operation: "discover",
    result_kind: "archive-item",
    source_class: "official",
    arguments: { query: "query", limit: "limit" },
  },
  ...READ_CONTRACT,
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      minLength: 1,
      description: "Internet Archive full-text query",
    },
    {
      name: "mediatype",
      type: "str",
      choices: SEARCH_MEDIATYPES,
      description: "Optional Internet Archive mediatype",
    },
    {
      name: "sort",
      type: "str",
      default: "downloads",
      choices: SEARCH_SORTS,
      description: "Descending sort field",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      minimum: 1,
      maximum: 100,
      description: "Maximum items",
    },
  ],
  columns: [
    "rank",
    "identifier",
    "title",
    "creator",
    "date",
    "mediatype",
    "downloads",
    "url",
  ],
  func: async (_page, kwargs) => {
    const query = String(kwargs.query ?? "").trim();
    if (!query) {
      throw archiveError(
        "invalid_input",
        "archive search query cannot be empty",
        "Provide a non-empty title, creator, subject, or free-text query.",
      );
    }
    const mediatype = kwargs.mediatype ? String(kwargs.mediatype).trim() : "";
    const sort = String(kwargs.sort ?? "downloads");
    const limit = requireArchiveLimit(
      kwargs.limit,
      20,
      100,
      "archive search limit",
    );
    const url = new URL("https://archive.org/advancedsearch.php");
    url.searchParams.set(
      "q",
      mediatype ? `(${query}) AND mediatype:${mediatype}` : query,
    );
    url.searchParams.set("output", "json");
    url.searchParams.set("rows", String(limit));
    url.searchParams.set("sort[]", `${sort} desc`);
    for (const field of [
      "identifier",
      "title",
      "creator",
      "date",
      "mediatype",
      "downloads",
    ]) {
      url.searchParams.append("fl[]", field);
    }
    return mapArchiveSearchRows(
      await fetchArchiveJson(url, "archive search"),
      limit,
    );
  },
});

cli({
  site: "archive",
  name: "snapshots",
  description: "List Wayback Machine CDX snapshots for a URL and time range",
  domain: "web.archive.org",
  strategy: Strategy.PUBLIC,
  operation_family: "list",
  ...READ_CONTRACT,
  args: [
    {
      name: "url",
      type: "str",
      required: true,
      positional: true,
      minLength: 1,
      description: "URL to inspect",
      "x-unicli-accepts": ["url"],
    },
    {
      name: "from",
      type: "str",
      pattern: "^\\d{4}(?:\\d{2}){0,5}$",
      description: "Earliest timestamp",
    },
    {
      name: "to",
      type: "str",
      pattern: "^\\d{4}(?:\\d{2}){0,5}$",
      description: "Latest timestamp",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      minimum: 1,
      maximum: 1000,
      description: "Maximum snapshots",
    },
  ],
  columns: ["timestamp", "snapshot_url", "status", "mimetype", "original_url"],
  func: async (_page, kwargs) => {
    const target = String(kwargs.url ?? "").trim();
    if (!target) {
      throw archiveError(
        "invalid_input",
        "archive snapshots URL cannot be empty",
        "Provide a URL or domain to inspect.",
      );
    }
    const limit = requireArchiveLimit(
      kwargs.limit,
      20,
      1000,
      "archive snapshots limit",
    );
    const url = new URL("http://web.archive.org/cdx/search/cdx");
    url.searchParams.set("url", target);
    url.searchParams.set("output", "json");
    url.searchParams.set("limit", String(limit));
    if (kwargs.from) url.searchParams.set("from", String(kwargs.from));
    if (kwargs.to) url.searchParams.set("to", String(kwargs.to));
    return mapArchiveSnapshotRows(
      await fetchArchiveJson(url, "archive snapshots"),
      limit,
    );
  },
});

cli({
  site: "archive",
  name: "wayback",
  description: "Resolve the closest Wayback Machine snapshot for a URL",
  domain: "archive.org",
  strategy: Strategy.PUBLIC,
  operation_family: "get",
  ...READ_CONTRACT,
  args: [
    {
      name: "url",
      type: "str",
      required: true,
      positional: true,
      minLength: 1,
      description: "URL to resolve",
      "x-unicli-accepts": ["url"],
    },
    {
      name: "timestamp",
      type: "str",
      description: "Preferred timestamp or ISO date",
    },
  ],
  columns: [
    "original_url",
    "requested_timestamp",
    "snapshot_timestamp",
    "snapshot_url",
    "status",
  ],
  func: async (_page, kwargs) => {
    const target = String(kwargs.url ?? "").trim();
    if (!target) {
      throw archiveError(
        "invalid_input",
        "archive wayback URL cannot be empty",
        "Provide a URL or domain to resolve.",
      );
    }
    const timestamp = kwargs.timestamp
      ? normalizeArchiveTimestamp(kwargs.timestamp)
      : "";
    const url = new URL("https://archive.org/wayback/available");
    url.searchParams.set("url", target);
    if (timestamp) url.searchParams.set("timestamp", timestamp);
    return [
      mapArchiveWaybackRow(
        await fetchArchiveJson(url, "archive wayback"),
        target,
        timestamp,
      ),
    ];
  },
});
