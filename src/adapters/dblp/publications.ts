/**
 * @owner       src::adapters::dblp::publications
 * @does        Registers DBLP publication, paper, author, and venue commands for computer-science bibliography discovery.
 * @needs       dblp public JSON/XML APIs, cheerio XML parsing, bounded fetch, and the command registry
 * @feeds       src/commands/scholar.ts via scholar.search, scholar.get, scholar.pdf, scholar.author, and scholar.venue
 * @breaks      DBLP API envelope drift, record-key parsing drift, or missing normalized ids makes CS bibliography rows invisible to the scholar meta-command.
 * @invariants  DBLP `key` is the source-local scholarly id and is mirrored as `dblp_key`; DOI remains a separate cross-source dedupe key.
 * @side-effects HTTPS egress to dblp.org only
 * @perf        Search maps one bounded page; author records require one XML fetch and O(N log N) chronological ordering
 * @concurrency safe
 * @test        src/adapters/dblp/publications.test.ts; live smoke via `unicli dblp search <query>` and `unicli scholar doctor --sources dblp --live`
 * @stability   experimental
 * @since       2026-05-19
 */

import { load } from "cheerio";
import { cli, Strategy } from "../../registry.js";
import { PipelineError } from "../../engine/executor.js";
import {
  fetchTextResource,
  type TextResource,
} from "../../engine/steps/fetch-text.js";

const DBLP_ORIGIN = "https://dblp.org";
const DBLP_TIMEOUT_MS = 15_000;
const RECORD_KEY_RE = /^[a-z]+(?:\/[A-Za-z0-9_.-]+)+$/;
const PID_RE = /^[0-9a-z]+(?:\/[0-9a-z-]+)+$/i;

interface DblpAuthorField {
  author?: unknown;
}

interface DblpHitInfo {
  key?: unknown;
  title?: unknown;
  authors?: DblpAuthorField;
  author?: unknown;
  venue?: unknown;
  year?: unknown;
  type?: unknown;
  doi?: unknown;
  ee?: unknown;
  url?: unknown;
  acronym?: unknown;
}

interface DblpHit {
  info?: DblpHitInfo;
}

interface DblpSearchBody {
  result?: {
    status?: { "@code"?: unknown; text?: unknown };
    hits?: { hit?: DblpHit[] | DblpHit; "@total"?: unknown };
  };
}

interface DblpActionableError extends Error {
  code: string;
  suggestion: string;
  retryable: boolean;
  alternatives: string[];
}

function dblpError(
  code: string,
  message: string,
  suggestion: string,
  alternatives: string[] = [],
): DblpActionableError {
  return Object.assign(new Error(message), {
    code,
    suggestion,
    retryable: false,
    alternatives,
  });
}

export function dblpEmptyResult(message: string): DblpActionableError {
  return dblpError(
    "empty_result",
    message,
    "Broaden the query, verify the DBLP key, PID, or venue, or select another scholarly source.",
    ["unicli scholar search <query> --sources openalex,crossref"],
  );
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function requireDblpQuery(value: unknown, label = "query"): string {
  const query = String(value ?? "").trim();
  if (!query) {
    throw dblpError(
      "invalid_input",
      `dblp ${label} cannot be empty.`,
      `Provide a non-empty dblp ${label}.`,
    );
  }
  return query;
}

export function requireDblpLimit(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw dblpError(
      "invalid_input",
      `limit must be an integer in [1, ${max}].`,
      `Choose a limit from 1 through ${max}.`,
    );
  }
  return n;
}

export function requireRecordKey(value: unknown): string {
  const raw = String(value ?? "").trim();
  const key = raw
    .replace(/^https?:\/\/dblp\.org\/rec\//i, "")
    .replace(/\.(?:html|xml)$/, "");
  if (!key) {
    throw dblpError(
      "invalid_input",
      "dblp paper key is required.",
      "Provide a canonical key such as conf/nips/VaswaniSPUJGKP17.",
    );
  }
  if (!RECORD_KEY_RE.test(key)) {
    throw dblpError(
      "invalid_input",
      `dblp paper key "${String(value)}" is not valid.`,
      "Provide a canonical key such as conf/nips/VaswaniSPUJGKP17.",
    );
  }
  return key;
}

export function requirePid(value: unknown): string {
  const pid = String(value ?? "")
    .trim()
    .replace(/^https?:\/\/dblp\.org\/pid\//i, "")
    .replace(/\.(?:html|xml)$/, "");
  if (!PID_RE.test(pid)) {
    throw dblpError(
      "invalid_input",
      `dblp pid "${pid}" is not valid.`,
      "Provide a canonical DBLP PID such as 56/953.",
    );
  }
  return pid;
}

export function decodeXmlEntities(value: unknown): string {
  return load(String(value ?? ""), { xml: true })
    .root()
    .text();
}

function requireDblpOffset(value: unknown): number {
  const offset = value === undefined ? 0 : Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw dblpError(
      "invalid_input",
      "offset must be a non-negative integer.",
      "Use offset 0 for the first page.",
    );
  }
  return offset;
}

function stripTrailingDot(value: string): string {
  return value.replace(/\.\s*$/, "");
}

function trimAuthorHomonym(value: string): string {
  return value.replace(/\s+\d{4,}$/, "").trim();
}

function compactType(value: unknown): string {
  const type = stringField(value);
  if (/Conference and Workshop/i.test(type)) return "conf";
  if (/Conference or Workshop/i.test(type)) return "conf";
  if (/Journal/i.test(type)) return "journal";
  if (/Books and Theses/i.test(type)) return "book";
  if (/Editorship/i.test(type)) return "editorship";
  if (/Reference/i.test(type)) return "reference";
  if (/Informal/i.test(type)) return "preprint";
  if (/Series/i.test(type)) return "series";
  return type ? type.toLowerCase().split(/\s+/)[0] : "";
}

export function inferDblpConferenceYear(
  titleValue: unknown,
  venueValue: unknown,
): string {
  const title = decodeXmlEntities(titleValue);
  const acronym = decodeXmlEntities(venueValue).split(",")[0]?.trim();
  if (!acronym || acronym.length < 2) return "";
  const escaped = acronym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    title.match(
      new RegExp(`\\b${escaped}\\s+((?:19|20)\\d{2})\\b`, "i"),
    )?.[1] ?? ""
  );
}

export function normalizeDblpAuthors(authorsField: unknown): string[] {
  const raw =
    authorsField && typeof authorsField === "object"
      ? (authorsField as DblpAuthorField).author
      : undefined;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list
    .map((author) => {
      if (author && typeof author === "object") {
        const record = author as { text?: unknown; "#text"?: unknown };
        return trimAuthorHomonym(
          decodeXmlEntities(record.text ?? record["#text"]),
        );
      }
      return trimAuthorHomonym(decodeXmlEntities(author));
    })
    .filter(Boolean);
}

function hitList(body: DblpSearchBody, label: string): DblpHit[] {
  const code = stringField(body.result?.status?.["@code"]);
  if (code && code !== "200") {
    throw new Error(`${label} returned API status ${code}.`);
  }
  const hits = body.result?.hits?.hit;
  return Array.isArray(hits) ? hits : hits ? [hits] : [];
}

function searchPagination(
  body: DblpSearchBody,
  offset: number,
  count: number,
): Record<string, unknown> {
  const total = Number(body.result?.hits?.["@total"] ?? Number.NaN);
  return Number.isSafeInteger(total) && total >= 0
    ? {
        total_count: total,
        next_offset: offset + count < total ? offset + count : null,
      }
    : {};
}

export function mapPublicationHit(
  hit: DblpHit,
  rank: number,
): Record<string, unknown> {
  const info = hit.info ?? {};
  const key = stringField(info.key);
  const url = stringField(info.ee) || stringField(info.url);
  const publicationYear = stringField(info.year);
  const conferenceYear = inferDblpConferenceYear(info.title, info.venue);
  return {
    id: key,
    rank,
    key,
    dblp_key: key,
    title: stripTrailingDot(decodeXmlEntities(info.title)).trim(),
    authors: normalizeDblpAuthors(info.authors).join(", "),
    venue: decodeXmlEntities(info.venue),
    year: publicationYear,
    publication_year: publicationYear,
    conference_year: conferenceYear || undefined,
    type: compactType(info.type),
    doi: stringField(info.doi),
    source_url: url || (key ? `${DBLP_ORIGIN}/rec/${key}.html` : ""),
    landing_url: key ? `${DBLP_ORIGIN}/rec/${key}.html` : "",
    url,
  };
}

export function mapVenueHit(
  hit: DblpHit,
  rank: number,
): Record<string, unknown> {
  const info = hit.info ?? {};
  const url = stringField(info.url);
  return {
    rank,
    acronym: stringField(info.acronym),
    venue: decodeXmlEntities(info.venue),
    type: compactType(info.type),
    url: url.startsWith("http")
      ? url
      : url
        ? `${DBLP_ORIGIN}${url.startsWith("/") ? "" : "/"}${url}`
        : "",
  };
}

const RECORD_SELECTOR =
  "article,inproceedings,incollection,proceedings,book,phdthesis,mastersthesis,data,www";

export function mapRecordXml(xml: string): Record<string, unknown> {
  const $ = load(xml, { xml: true });
  const record = $(RECORD_SELECTOR).first();
  const key = record.attr("key") ?? "";
  const tag = record.prop("tagName")?.toLowerCase() ?? "";
  const type =
    tag === "inproceedings"
      ? "conf"
      : tag === "article"
        ? "journal"
        : tag === "proceedings"
          ? "editorship"
          : tag;
  const text = (name: string): string =>
    record.find(name).first().text().trim();
  const electronicEditions = record
    .find("ee")
    .map((_index, ee) => $(ee).text().trim())
    .get();
  const doi =
    electronicEditions
      .find((value) => /(?:doi\.org\/|^10\.)/i.test(value))
      ?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "") ?? "";
  const openAccessUrl = record.find('ee[type="oa"]').first().text().trim();
  const dblpUrl = key ? `${DBLP_ORIGIN}/rec/${key}.html` : "";
  const sourceUrl = openAccessUrl || electronicEditions[0] || dblpUrl;
  const authorPids = record
    .find("author[pid]")
    .map((_index, author) => $(author).attr("pid") ?? "")
    .get()
    .filter(Boolean);
  return {
    id: key,
    key,
    dblp_key: key,
    type,
    title: stripTrailingDot(text("title")),
    authors: record
      .find("author")
      .map((_index, author) => trimAuthorHomonym($(author).text()))
      .get()
      .filter(Boolean)
      .join(", "),
    ...(authorPids.length ? { author_pids: authorPids } : {}),
    venue: text("booktitle") || text("journal"),
    year: text("year"),
    pages: text("pages"),
    doi: doi.startsWith("10.") ? doi : "",
    open_access_url: openAccessUrl,
    source_url: sourceUrl,
    landing_url: dblpUrl,
    dblp_url: dblpUrl,
    url: sourceUrl,
  };
}

export function splitAuthorRecords(
  xml: string,
  offset = 0,
  limit = Infinity,
): string[] {
  const $ = load(xml, { xml: true });
  const records = $("r")
    .map((_index, entry) => {
      const record = $(entry).find(RECORD_SELECTOR).first();
      return record.length
        ? {
            record,
            year: Number(record.find("year").first().text()),
            key: record.attr("key") ?? "",
          }
        : null;
    })
    .get();
  return records
    .sort(
      (left, right) =>
        right.year - left.year || left.key.localeCompare(right.key),
    )
    .slice(offset, offset + limit)
    .map(({ record }) => $.xml(record));
}

function extractPidFromAuthorHit(hit: DblpHit): string {
  const url = stringField(hit.info?.url);
  const match = url.match(/\/pid\/(.+?)(?:\.(?:html|xml))?$/);
  return match ? requirePid(match[1]) : "";
}

export async function fetchDblp(
  path: string,
  label: string,
  accept: string,
  signal?: AbortSignal,
): Promise<TextResource> {
  const timeout = AbortSignal.timeout(DBLP_TIMEOUT_MS);
  try {
    return await fetchTextResource(
      `${DBLP_ORIGIN}${path}`,
      { url: `${DBLP_ORIGIN}${path}`, retry: 2, backoff: 250 },
      {
        "User-Agent": "unicli-dblp/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
        Accept: accept,
      },
      0,
      { signal: signal ? AbortSignal.any([signal, timeout]) : timeout },
    );
  } catch (error) {
    signal?.throwIfAborted();
    if (timeout.aborted) {
      throw Object.assign(
        dblpError(
          "timeout",
          `${label} timed out after ${DBLP_TIMEOUT_MS} ms.`,
          "Retry later or select another scholarly source.",
        ),
        { retryable: true },
      );
    }
    if (error instanceof PipelineError && error.detail.statusCode === 404) {
      throw dblpEmptyResult(`${label} returned no result.`);
    }
    throw error;
  }
}

async function fetchDblpJson(
  path: string,
  label: string,
  signal?: AbortSignal,
): Promise<DblpSearchBody> {
  const response = await fetchDblp(path, label, "application/json", signal);
  let body: DblpSearchBody;
  try {
    body = JSON.parse(response.text) as DblpSearchBody;
  } catch {
    throw dblpError(
      "upstream_error",
      `${label} returned invalid JSON.`,
      "Retry after DBLP returns its JSON API response.",
    );
  }
  if (!body?.result?.hits) {
    throw dblpError(
      "upstream_error",
      `${label} returned an incomplete search envelope.`,
      "Retry after DBLP returns its documented search response.",
    );
  }
  return body;
}

async function fetchDblpXml(
  path: string,
  label: string,
  signal?: AbortSignal,
): Promise<string> {
  return (await fetchDblp(path, label, "application/xml", signal)).text;
}

cli({
  site: "dblp",
  name: "search",
  description: "Search dblp computer-science bibliography",
  domain: "dblp.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "Publication search query",
    },
    { name: "limit", type: "int", default: 20, description: "Max results" },
    {
      name: "offset",
      type: "int",
      default: 0,
      description: "Pagination offset",
    },
  ],
  columns: [
    "rank",
    "key",
    "title",
    "authors",
    "venue",
    "year",
    "type",
    "doi",
    "url",
  ],
  capabilities: ["http.fetch", "scholar.search"],
  func: async (_page, kwargs, context) => {
    const query = requireDblpQuery(kwargs.query);
    const limit = requireDblpLimit(kwargs.limit, 20, 100);
    const offset = requireDblpOffset(kwargs.offset);
    const body = await fetchDblpJson(
      `/search/publ/api?q=${encodeURIComponent(query)}&format=json&h=${limit}&f=${offset}`,
      "dblp search",
      context.signal,
    );
    const rows = hitList(body, "dblp search")
      .slice(0, limit)
      .map((hit, index) => mapPublicationHit(hit, offset + index + 1));
    if (rows.length === 0) {
      throw dblpEmptyResult(`No dblp publications matched "${query}".`);
    }
    const pagination = searchPagination(body, offset, rows.length);
    return rows.map((row) => ({ ...row, ...pagination }));
  },
});

cli({
  site: "dblp",
  name: "paper",
  description: "Fetch a dblp record by canonical key",
  domain: "dblp.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "key",
      type: "str",
      required: true,
      positional: true,
      description: "Canonical dblp record key or record URL",
    },
  ],
  columns: [
    "key",
    "type",
    "title",
    "authors",
    "venue",
    "year",
    "pages",
    "doi",
    "open_access_url",
    "dblp_url",
  ],
  capabilities: ["http.fetch", "scholar.get", "scholar.pdf"],
  func: async (_page, kwargs, context) => {
    const key = requireRecordKey(kwargs.key);
    const xml = await fetchDblpXml(
      `/rec/${encodeURI(key)}.xml`,
      `dblp paper ${key}`,
      context.signal,
    );
    const row = mapRecordXml(xml);
    if (!row.key && !row.title) {
      throw dblpEmptyResult(`dblp returned an empty record for key "${key}".`);
    }
    return [row];
  },
});

cli({
  site: "dblp",
  name: "venue",
  description: "Search dblp venue registry by name or acronym",
  domain: "dblp.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "Venue name or acronym",
    },
    { name: "limit", type: "int", default: 20, description: "Max venues" },
    {
      name: "offset",
      type: "int",
      default: 0,
      description: "Pagination offset",
    },
  ],
  columns: ["rank", "acronym", "venue", "type", "url"],
  capabilities: ["http.fetch", "scholar.venue"],
  func: async (_page, kwargs, context) => {
    const query = requireDblpQuery(kwargs.query);
    const limit = requireDblpLimit(kwargs.limit, 20, 100);
    const offset = requireDblpOffset(kwargs.offset);
    const body = await fetchDblpJson(
      `/search/venue/api?q=${encodeURIComponent(query)}&format=json&h=${limit}&f=${offset}`,
      "dblp venue",
      context.signal,
    );
    const rows = hitList(body, "dblp venue")
      .slice(0, limit)
      .map((hit, index) => mapVenueHit(hit, offset + index + 1));
    if (rows.length === 0) {
      throw dblpEmptyResult(`No dblp venues matched "${query}".`);
    }
    const pagination = searchPagination(body, offset, rows.length);
    return rows.map((row) => ({ ...row, ...pagination }));
  },
});

cli({
  site: "dblp",
  name: "author",
  description: "List dblp publications by author name or PID",
  domain: "dblp.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "author",
      type: "str",
      positional: true,
      description: "Author name; optional when pid is given",
    },
    { name: "pid", type: "str", description: "Canonical dblp PID" },
    {
      name: "limit",
      type: "int",
      default: 20,
      description:
        "Max publications, ordered by year descending then record key",
    },
    {
      name: "offset",
      type: "int",
      default: 0,
      description: "Pagination offset",
    },
  ],
  columns: [
    "rank",
    "key",
    "title",
    "authors",
    "venue",
    "year",
    "type",
    "doi",
    "pid",
    "url",
  ],
  capabilities: ["http.fetch", "scholar.author", "scholar.search"],
  func: async (_page, kwargs, context) => {
    const limit = requireDblpLimit(kwargs.limit, 20, 200);
    const offset = requireDblpOffset(kwargs.offset);
    let pid = kwargs.pid ? requirePid(kwargs.pid) : "";
    if (!pid) {
      const author = requireDblpQuery(kwargs.author, "author");
      const body = await fetchDblpJson(
        `/search/author/api?q=${encodeURIComponent(author)}&format=json&h=20`,
        "dblp author search",
        context.signal,
      );
      const hits = hitList(body, "dblp author search");
      if (hits.length === 0) {
        throw dblpEmptyResult(`No dblp author matched "${author}".`);
      }
      const exact = hits.filter(
        (hit) =>
          decodeXmlEntities(hit.info?.author).toLocaleLowerCase() ===
          author.toLocaleLowerCase(),
      );
      const candidates = exact.length > 0 ? exact : hits;
      if (candidates.length > 1) {
        throw dblpError(
          "invalid_input",
          `Several DBLP authors match "${author}".`,
          "Select the intended author with --pid.",
          candidates
            .map(
              (hit) =>
                `unicli dblp author --pid ${extractPidFromAuthorHit(hit)}`,
            )
            .filter((command) => !command.endsWith(" ")),
        );
      }
      pid = extractPidFromAuthorHit(candidates[0]);
      if (!pid) {
        throw dblpEmptyResult(
          `dblp author search returned no PID for "${author}".`,
        );
      }
    }
    const xml = await fetchDblpXml(
      `/pid/${pid}.xml`,
      `dblp pid ${pid}`,
      context.signal,
    );
    const records = splitAuthorRecords(xml, offset, limit);
    if (records.length === 0 && offset === 0) {
      throw dblpEmptyResult(`dblp PID ${pid} has no publications.`);
    }
    return records.map((record, index) => ({
      ...mapRecordXml(record),
      rank: offset + index + 1,
      pid,
    }));
  },
});
