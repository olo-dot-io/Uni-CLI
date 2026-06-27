/**
 * @owner       src::adapters::cnki::search
 * @does        Registers CNKI Scholar title search against the current public KNS criteria endpoint.
 * @needs       scholar.cnki.net KNS criteria API, node:crypto, src/registry.ts, src/types/scholarly.ts
 * @feeds       `unicli cnki search`, src/commands/scholar.ts via scholar.search, scholar doctor live probes
 * @breaks      CNKI token/request-shape drift surfaces as upstream_error; access-controlled PDF/order URLs are exposed as relation hints, not as a scholar.pdf guarantee.
 * @invariants  Search uses CNKI's current all-database class id; rows must carry source-local id/title/source_adapter/retrieved_at; no stale API fallback is kept.
 * @side-effects HTTPS egress to scholar.cnki.net only
 * @perf        O(limit) JSON mapping after one POST request.
 * @concurrency safe
 * @test        tests/unit/adapters/scholar-sources.test.ts; live smoke via `unicli cnki search <query>` and `unicli scholar doctor --sources cnki --live`
 * @stability   experimental
 * @since       2026-06-27
 */

import { createCipheriv } from "node:crypto";

import { cli, Strategy } from "../../registry.js";
import type { ScholarlyWorkRecord } from "../../types/scholarly.js";

const CNKI_QUERY_API =
  "https://scholar.cnki.net/restapi/kns8s-api/v2/criteria/query";
const CNKI_TOKEN_SECRET = "cf4e8f25360248f89248af06a55d21ea";
const CNKI_CLIENT_ID = "c5fd4ef0-d314-4888-b0a7-f6190eaefaf0";
const CNKI_ALL_DATABASE_CLASS_ID = "WD0FTY92";
const CNKI_REFERER = "https://scholar.cnki.net/";
const MAX_LIMIT = 50;

interface CnkiMetadataEntry {
  name?: unknown;
  value?: unknown;
}

interface CnkiRelation {
  scope?: unknown;
  url?: unknown;
}

interface CnkiAuthor {
  title?: unknown;
}

interface CnkiSource {
  title?: unknown;
  type?: unknown;
  year?: unknown;
  relations?: CnkiRelation[];
}

export interface CnkiSearchRow {
  metadata?: CnkiMetadataEntry[];
  relations?: CnkiRelation[];
  authors?: CnkiAuthor[];
  source?: CnkiSource;
}

interface CnkiSearchResponse {
  code?: unknown;
  message?: unknown;
  data?: {
    total?: unknown;
    data?: CnkiSearchRow[];
  };
}

interface CnkiSearchPayload {
  Resource: string;
  Classid: string;
  Products: string;
  KuaKuCode: string;
  QNode: {
    QGroup: Array<{
      Key: string;
      Title: string;
      Logic: number;
      Items: unknown[];
      ChildItems: Array<{
        Key: string;
        Title: string;
        Logic: number;
        Items: Array<{
          Key: string;
          Title: string;
          Logic: number;
          Field: string;
          Operator: string;
          Value: string;
        }>;
        ChildItems: unknown[];
      }>;
    }>;
  };
  ExScope: string;
  SearchType: number;
  SearchFrom: number;
  Rlang: string;
  sort: string;
  sortType: string;
  pageNum: number;
  pageSize: number;
}

type ActionableError = Error & {
  code?: string;
  suggestion?: string;
  retryable?: boolean;
};

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stripHtml(value: unknown): string {
  return str(value)
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function metadataValue(row: CnkiSearchRow, name: string): string {
  const entry = row.metadata?.find(
    (candidate) => str(candidate.name).toUpperCase() === name,
  );
  return stripHtml(entry?.value);
}

function relationUrl(
  relations: CnkiRelation[] | undefined,
  scope: string,
): string {
  const found = relations?.find(
    (relation) => str(relation.scope).toUpperCase() === scope,
  );
  return str(found?.url);
}

function firstRelationUrl(row: CnkiSearchRow, scopes: string[]): string {
  for (const scope of scopes) {
    const rowUrl = relationUrl(row.relations, scope);
    if (rowUrl) return rowUrl;
    const sourceUrl = relationUrl(row.source?.relations, scope);
    if (sourceUrl) return sourceUrl;
  }
  return "";
}

function parseYear(value: string): number | undefined {
  const year = Number(value.match(/(?:19|20)\d{2}/)?.[0]);
  return Number.isInteger(year) ? year : undefined;
}

function splitMetadataAuthors(value: string): string[] {
  return value
    .split(/[;；]/)
    .map((author) => author.trim())
    .filter(Boolean);
}

function cnkiError(message: string, code = "upstream_error"): ActionableError {
  const error = new Error(message) as ActionableError;
  error.code = code;
  error.suggestion =
    "CNKI changed or rejected the public KNS criteria query. Run `unicli describe cnki search`, then inspect scholar.cnki.net's current search request before changing the adapter.";
  error.retryable = false;
  return error;
}

export function createCnkiVvToken(timestamp = Date.now()): string {
  const cipher = createCipheriv(
    "aes-256-ecb",
    Buffer.from(CNKI_TOKEN_SECRET, "utf8"),
    null,
  );
  cipher.setAutoPadding(true);
  return Buffer.concat([
    cipher.update(JSON.stringify({ timestamp }), "utf8"),
    cipher.final(),
  ]).toString("hex");
}

export function buildCnkiSearchPayload(
  query: string,
  limit: number,
): CnkiSearchPayload {
  return {
    Resource: "",
    Classid: CNKI_ALL_DATABASE_CLASS_ID,
    Products: "",
    KuaKuCode: "",
    QNode: {
      QGroup: [
        {
          Key: "",
          Title: "",
          Logic: 0,
          Items: [],
          ChildItems: [
            {
              Key: "subject",
              Title: "",
              Logic: 0,
              Items: [
                {
                  Key: "",
                  Title: "题名",
                  Logic: 0,
                  Field: "TI",
                  Operator: "FUZZY",
                  Value: query,
                },
              ],
              ChildItems: [],
            },
          ],
        },
      ],
    },
    ExScope: "1",
    SearchType: 2,
    SearchFrom: 1,
    Rlang: "",
    sort: "PT",
    sortType: "DESC",
    pageNum: 1,
    pageSize: limit,
  };
}

export function mapCnkiSearchRow(
  row: CnkiSearchRow,
  rank: number,
): ScholarlyWorkRecord & { rank: number; pdf_url?: string } {
  const title = metadataValue(row, "TI") || metadataValue(row, "ENTI");
  const doi = metadataValue(row, "DOI").replace(/^doi:/i, "");
  const date = metadataValue(row, "PT");
  const source = metadataValue(row, "LY") || stripHtml(row.source?.title);
  const authorNames =
    row.authors?.map((author) => stripHtml(author.title)).filter(Boolean) ?? [];
  const authors = authorNames.length
    ? authorNames
    : splitMetadataAuthors(metadataValue(row, "AU"));
  const sourceUrl = firstRelationUrl(row, ["ABSTRACT", "PUBLICATION"]);
  const pdfUrl = firstRelationUrl(row, ["PDF"]);
  const id =
    metadataValue(row, "ID") ||
    metadataValue(row, "FN") ||
    doi ||
    sourceUrl ||
    title;
  if (!id || !title) {
    throw cnkiError("CNKI returned a row without a stable id or title.");
  }
  const citedByCount = Number(metadataValue(row, "CF"));
  return {
    id,
    rank,
    title,
    authors,
    year: parseYear(date) ?? parseYear(str(row.source?.year)),
    date: date || undefined,
    venue: source || undefined,
    type: metadataValue(row, "DB") || stripHtml(row.source?.type) || undefined,
    abstract: metadataValue(row, "AB") || undefined,
    doi: doi || undefined,
    cited_by_count: Number.isFinite(citedByCount) ? citedByCount : undefined,
    pdf_url: pdfUrl || undefined,
    landing_url: sourceUrl || undefined,
    source_adapter: "cnki",
    source_url: sourceUrl || undefined,
    retrieved_at: new Date().toISOString(),
  };
}

async function fetchCnkiSearch(
  payload: CnkiSearchPayload,
): Promise<CnkiSearchResponse> {
  const url = new URL(CNKI_QUERY_API);
  url.searchParams.set("vv", createCnkiVvToken());
  url.searchParams.set("clientId", CNKI_CLIENT_ID);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json;charset=UTF-8",
      Origin: "https://scholar.cnki.net",
      Referer: CNKI_REFERER,
      "User-Agent":
        "Mozilla/5.0 (compatible; Uni-CLI/1.0; +https://github.com/olo-dot-io/Uni-CLI)",
      Version: "",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw cnkiError(`CNKI search returned HTTP ${response.status}.`);
  }
  const json = (await response.json()) as CnkiSearchResponse;
  const code = Number(json.code);
  if (code !== 0) {
    throw cnkiError(
      `CNKI search returned code ${String(json.code)}: ${str(json.message)}`,
    );
  }
  return json;
}

cli({
  site: "cnki",
  name: "search",
  description: "Search CNKI academic papers by title",
  domain: "scholar.cnki.net",
  strategy: Strategy.PUBLIC,
  adapter_path: "src/adapters/cnki/search.ts",
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: [
    "rank",
    "id",
    "title",
    "authors",
    "venue",
    "year",
    "doi",
    "cited_by_count",
    "pdf_url",
    "source_url",
  ],
  capabilities: ["http.fetch", "scholar.search"],
  func: async (_page, kwargs) => {
    const query = str(kwargs.query);
    if (!query) {
      const error = new Error(
        "cnki search query cannot be empty.",
      ) as ActionableError;
      error.code = "invalid_input";
      error.suggestion =
        "Pass a CNKI title keyword, for example `unicli cnki search 人工智能`.";
      error.retryable = false;
      throw error;
    }
    const requestedLimit = Number(kwargs.limit ?? 20);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), MAX_LIMIT)
      : 20;
    const payload = buildCnkiSearchPayload(query, limit);
    const response = await fetchCnkiSearch(payload);
    const rows = Array.isArray(response.data?.data) ? response.data.data : [];
    return rows.map((row, index) => mapCnkiSearchRow(row, index + 1));
  },
});
