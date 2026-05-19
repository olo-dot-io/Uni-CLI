/**
 * @owner   src/adapters/dblp/publications.ts
 * @does    Register agent-facing dblp publication, author, paper, and venue commands.
 * @needs   dblp public JSON/XML APIs, conservative XML field extraction, bounded result limits.
 * @feeds   surface coverage ledger, scholarly search surface, CS bibliography inspection.
 * @breaks  dblp API envelope drift, record-key parsing, or silent empty rows hide bibliography lookup failures.
 */

import { cli, Strategy } from "../../registry.js";

const DBLP_ORIGIN = "https://dblp.org";
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
    hits?: { hit?: DblpHit[] | DblpHit };
  };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function requireDblpQuery(value: unknown, label = "query"): string {
  const query = String(value ?? "").trim();
  if (!query) throw new Error(`dblp ${label} cannot be empty.`);
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
    throw new Error(`limit must be an integer in [1, ${max}].`);
  }
  return n;
}

export function requireRecordKey(value: unknown): string {
  const key = String(value ?? "").trim();
  if (!key) throw new Error("dblp paper key is required.");
  if (!RECORD_KEY_RE.test(key)) {
    throw new Error(`dblp paper key "${String(value)}" is not valid.`);
  }
  return key;
}

export function requirePid(value: unknown): string {
  const pid = String(value ?? "").trim();
  if (!PID_RE.test(pid)) throw new Error(`dblp pid "${pid}" is not valid.`);
  return pid;
}

export function decodeXmlEntities(value: unknown): string {
  return String(value ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_m, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    );
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

export function mapPublicationHit(
  hit: DblpHit,
  rank: number,
): Record<string, unknown> {
  const info = hit.info ?? {};
  const key = stringField(info.key);
  return {
    rank,
    key,
    title: stripTrailingDot(decodeXmlEntities(info.title)).trim(),
    authors: normalizeDblpAuthors(info.authors).join(", "),
    venue: decodeXmlEntities(info.venue),
    year: stringField(info.year),
    type: compactType(info.type),
    doi: stringField(info.doi),
    url: stringField(info.ee) || stringField(info.url),
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

export function extractFirst(xml: string, tag: string): string {
  const match = xml.match(
    new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`),
  );
  return match ? match[1] : "";
}

export function extractAll(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) out.push(match[1]);
  return out;
}

export function extractRecordKey(xml: string): string {
  const match = xml.match(
    /<(?:article|inproceedings|incollection|proceedings|book|phdthesis|mastersthesis)\b[^>]*\bkey="([^"]+)"/,
  );
  return match ? match[1] : "";
}

function extractRecordType(xml: string): string {
  const match = xml.match(
    /<(article|inproceedings|incollection|proceedings|book|phdthesis|mastersthesis)\b/,
  );
  if (!match) return "";
  switch (match[1]) {
    case "inproceedings":
      return "conf";
    case "article":
      return "journal";
    case "incollection":
      return "incollection";
    case "proceedings":
      return "editorship";
    default:
      return match[1];
  }
}

function extractOpenAccessUrl(xml: string): string {
  const oa = xml.match(/<ee\b[^>]*type=["']oa["'][^>]*>([\s\S]*?)<\/ee>/);
  if (oa) return stringField(decodeXmlEntities(oa[1]));
  const any = xml.match(/<ee\b[^>]*>([\s\S]*?)<\/ee>/);
  return any ? stringField(decodeXmlEntities(any[1])) : "";
}

export function mapRecordXml(xml: string): Record<string, unknown> {
  const key = extractRecordKey(xml);
  const type = extractRecordType(xml);
  const venue =
    type === "conf"
      ? decodeXmlEntities(extractFirst(xml, "booktitle"))
      : decodeXmlEntities(extractFirst(xml, "journal"));
  const ee = extractAll(xml, "ee")
    .map(decodeXmlEntities)
    .find((value) => /(?:doi\.org\/|^10\.)/i.test(value));
  const doi = ee ? ee.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "") : "";
  return {
    key,
    type,
    title: stripTrailingDot(decodeXmlEntities(extractFirst(xml, "title"))),
    authors: extractAll(xml, "author")
      .map((author) => trimAuthorHomonym(decodeXmlEntities(author)))
      .filter(Boolean)
      .join(", "),
    venue,
    year: decodeXmlEntities(extractFirst(xml, "year")),
    pages: decodeXmlEntities(extractFirst(xml, "pages")),
    doi: doi.startsWith("10.") ? doi : "",
    open_access_url: extractOpenAccessUrl(xml),
    dblp_url: key ? `${DBLP_ORIGIN}/rec/${key}.html` : "",
  };
}

export function splitAuthorRecords(xml: string): string[] {
  const records: string[] = [];
  const re = /<r>\s*([\s\S]*?)\s*<\/r>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const record = match[1];
    if (!record.startsWith("<crossref")) records.push(record);
  }
  return records;
}

function extractPidFromAuthorHit(hit: DblpHit): string {
  const url = stringField(hit.info?.url);
  const match = url.match(/\/pid\/([^/]+(?:\/[^/]+)+)$/);
  return match ? match[1] : "";
}

async function fetchDblp(
  path: string,
  label: string,
  accept: string,
): Promise<Response> {
  const response = await fetch(`${DBLP_ORIGIN}${path}`, {
    headers: {
      "User-Agent": "unicli-dblp/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
      Accept: accept,
    },
  });
  if (response.status === 404) throw new Error(`${label} returned no result.`);
  if (response.status === 429) throw new Error(`${label} returned HTTP 429.`);
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}.`);
  return response;
}

async function fetchDblpJson(
  path: string,
  label: string,
): Promise<DblpSearchBody> {
  return (
    await fetchDblp(path, label, "application/json")
  ).json() as Promise<DblpSearchBody>;
}

async function fetchDblpXml(path: string, label: string): Promise<string> {
  return (await fetchDblp(path, label, "application/xml")).text();
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
  func: async (_page, kwargs) => {
    const query = requireDblpQuery(kwargs.query);
    const limit = requireDblpLimit(kwargs.limit, 20, 100);
    const body = await fetchDblpJson(
      `/search/publ/api?q=${encodeURIComponent(query)}&format=json&h=${limit}`,
      "dblp search",
    );
    const rows = hitList(body, "dblp search")
      .slice(0, limit)
      .map((hit, index) => mapPublicationHit(hit, index + 1));
    if (rows.length === 0)
      throw new Error(`No dblp publications matched "${query}".`);
    return rows;
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
      description: "dblp record key",
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
  func: async (_page, kwargs) => {
    const key = requireRecordKey(kwargs.key);
    const xml = await fetchDblpXml(
      `/rec/${encodeURI(key)}.xml`,
      `dblp paper ${key}`,
    );
    const row = mapRecordXml(xml);
    if (!row.key && !row.title) {
      throw new Error(`dblp returned an empty record for key "${key}".`);
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
  ],
  columns: ["rank", "acronym", "venue", "type", "url"],
  capabilities: ["http.fetch", "scholar.venue"],
  func: async (_page, kwargs) => {
    const query = requireDblpQuery(kwargs.query);
    const limit = requireDblpLimit(kwargs.limit, 20, 100);
    const body = await fetchDblpJson(
      `/search/venue/api?q=${encodeURIComponent(query)}&format=json&h=${limit}`,
      "dblp venue",
    );
    const rows = hitList(body, "dblp venue")
      .slice(0, limit)
      .map((hit, index) => mapVenueHit(hit, index + 1));
    if (rows.length === 0)
      throw new Error(`No dblp venues matched "${query}".`);
    return rows;
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
      description: "Max publications",
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
  func: async (_page, kwargs) => {
    const limit = requireDblpLimit(kwargs.limit, 20, 200);
    let pid = kwargs.pid ? requirePid(kwargs.pid) : "";
    if (!pid) {
      const author = requireDblpQuery(kwargs.author, "author");
      const body = await fetchDblpJson(
        `/search/author/api?q=${encodeURIComponent(author)}&format=json&h=20`,
        "dblp author search",
      );
      const hits = hitList(body, "dblp author search");
      if (hits.length === 0)
        throw new Error(`No dblp author matched "${author}".`);
      pid = extractPidFromAuthorHit(hits[0]);
      if (!pid)
        throw new Error(`dblp author search returned no PID for "${author}".`);
    }
    const xml = await fetchDblpXml(`/pid/${pid}.xml`, `dblp pid ${pid}`);
    const records = splitAuthorRecords(xml);
    if (records.length === 0)
      throw new Error(`dblp PID ${pid} has no publications.`);
    return records.slice(0, limit).map((record, index) => {
      const row = mapRecordXml(`<root>${record}</root>`);
      return {
        rank: index + 1,
        key: row.key || extractRecordKey(record),
        title: row.title,
        authors: row.authors,
        venue: row.venue,
        year: row.year,
        type: row.type,
        doi: row.doi,
        pid,
        url: row.open_access_url || row.dblp_url,
      };
    });
  },
});
