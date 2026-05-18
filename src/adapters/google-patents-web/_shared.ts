/**
 * @owner       src::adapters::google-patents-web::_shared
 * @does        Shared HTTP helpers and types for the KEYLESS Google Patents web adapter — distinct from the BigQuery-backed google-patents-bq adapter (which requires a billed GCP project). This adapter uses the public XHR endpoint that drives patents.google.com and the SSR /patent/<id>/en bibliography page, both of which are reachable with only a real-browser User-Agent header.
 * @needs       src/engine/normalizer/patent-envelope.ts, src/types/patent.ts, node:fetch (global)
 * @feeds       src/adapters/google-patents-web/search.yaml, src/adapters/google-patents-web/get.ts
 * @breaks      throws GooglePatentsHttpError when the endpoint returns non-2xx or unparseable JSON; callers surface PATENT_API_DEPRECATED to the meta-command
 * @invariants  every outbound request carries a real-browser User-Agent — Google rejects bare `node-fetch`/`python-requests`; the @keyless-best-effort verification tag is emitted in adapter file headers
 * @side-effects HTTPS egress to patents.google.com only; no env reads, no cookies
 * @perf        single request per call; XHR responses are ~40-100 KB
 * @concurrency safe — pure functions plus stateless `fetch`
 * @test        covered transitively via tests/unit/adapters/google-patents-web/*.test.ts (none yet — adapters ship with live verification proof in docs/skills/patent-cookbook.md)
 * @stability   experimental — Google does not publish a stability contract for this XHR
 * @since       2026-05-18
 * @verification keyless-best-effort
 */

import type { PatentRecord } from "../../types/patent.js";

/**
 * Local verification-status alias for the keyless-web adapter family.
 *
 * Distinct from the canonical `PatentVerificationStatus` union in
 * `src/types/patent.ts` — adding a new variant there is owned by another
 * agent in this batch, so we expose it as a *local* string-literal type
 * alias the file headers can advertise without forcing a cross-cutting
 * type change. The meta-command does not branch on this value; it is
 * documentation-grade only.
 */
export type KeylessBestEffortStatus = "keyless-best-effort";
export const KEYLESS_BEST_EFFORT: KeylessBestEffortStatus =
  "keyless-best-effort";

/**
 * Real-browser User-Agent string. Google's XHR endpoint returns 403 for the
 * default `node/undici` UA; a Chrome string fixes that. Mirror the version
 * Chrome currently ships rather than freezing on an old number so the header
 * stays plausible if Google starts UA-version-gating in future.
 */
export const GOOGLE_PATENTS_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

export class GooglePatentsHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    message: string,
  ) {
    super(message);
    this.name = "GooglePatentsHttpError";
  }
}

/**
 * GET <url> with a real-browser UA. Returns parsed JSON; throws
 * GooglePatentsHttpError on non-2xx or JSON parse failure.
 */
export async function fetchGooglePatentsJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": GOOGLE_PATENTS_UA,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new GooglePatentsHttpError(
      response.status,
      url,
      `Google Patents XHR returned HTTP ${response.status}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    throw new GooglePatentsHttpError(
      response.status,
      url,
      `Google Patents XHR returned non-JSON body: ${(err as Error).message}`,
    );
  }
  return parsed as T;
}

/**
 * GET <url> with a real-browser UA, return raw HTML text. Throws
 * GooglePatentsHttpError on non-2xx.
 */
export async function fetchGooglePatentsHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": GOOGLE_PATENTS_UA,
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!response.ok) {
    throw new GooglePatentsHttpError(
      response.status,
      url,
      `Google Patents detail page returned HTTP ${response.status}`,
    );
  }
  return await response.text();
}

/**
 * Build the public XHR query URL. Accepts a plain free-text query string and
 * an optional limit (`num` parameter) and earliest-publication-year filter.
 *
 * The XHR endpoint expects a percent-encoded *inner* query string under the
 * `url` parameter — the outer query is `?url=q%3Dfoo&exp=`. We percent-encode
 * the inner once.
 */
export function buildGooglePatentsXhrUrl(
  query: string,
  limit?: number,
  sinceYear?: string,
): string {
  const cleaned = query.trim();
  let inner = `q=${cleaned.replace(/\s+/g, "+")}`;
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
    inner += `&num=${Math.min(100, Math.max(1, Math.floor(limit)))}`;
  }
  if (sinceYear && /^\d{4}$/.test(sinceYear)) {
    inner += `&after=publication:${sinceYear}0101`;
  }
  return `https://patents.google.com/xhr/query?url=${encodeURIComponent(inner)}&exp=`;
}

/**
 * Build the public detail page URL for a given publication number. Google
 * accepts the segmented form `US-11741188-B2` and the compact form
 * `US11741188B2`; we send the compact form to keep the URL short.
 */
export function buildGooglePatentsDetailUrl(pubNo: string): string {
  const compact = pubNo.replace(/-/g, "").toUpperCase();
  return `https://patents.google.com/patent/${encodeURIComponent(compact)}/en`;
}

/**
 * XHR response shape. We intentionally type only the fields we read —
 * Google ships many more (figure thumbnails, family metadata, language) that
 * we either ignore or carry through verbatim in `raw`.
 */
export interface GoogleXhrResultRow {
  id: string;
  rank?: number;
  patent?: {
    title?: string;
    snippet?: string;
    publication_number?: string;
    inventor?: string;
    assignee?: string;
    filing_date?: string;
    publication_date?: string;
    grant_date?: string;
    priority_date?: string;
    language?: string;
  };
}

export interface GoogleXhrResponse {
  results?: {
    cluster?: Array<{ result?: GoogleXhrResultRow[] }>;
    total_num_results?: number;
  };
}

/**
 * Flatten the nested `results.cluster[].result[]` into a single array, in
 * server-supplied order.
 */
export function flattenGoogleXhrResults(
  body: GoogleXhrResponse,
): GoogleXhrResultRow[] {
  const clusters = body.results?.cluster ?? [];
  const out: GoogleXhrResultRow[] = [];
  for (const cluster of clusters) {
    const rows = cluster.result ?? [];
    for (const row of rows) out.push(row);
  }
  return out;
}

/**
 * Project a single XHR row to the upstream-facing partial-PatentRecord
 * shape. Empty / missing fields are left undefined rather than synthesised.
 * Snippets contain HTML markup (e.g. `<b>` tags) which we strip.
 */
export function projectGoogleRowToRecord(
  row: GoogleXhrResultRow,
  sourceUrl: string,
): Partial<PatentRecord> & {
  publication_number: string;
  source_adapter: string;
} {
  const patent = row.patent ?? {};
  const pubNo =
    (typeof patent.publication_number === "string" &&
      patent.publication_number) ||
    deriveCanonicalFromId(row.id);
  const cleanSnippet = patent.snippet ? stripHtml(patent.snippet) : undefined;
  return {
    publication_number: pubNo,
    title: patent.title ? patent.title.trim() : undefined,
    abstract: cleanSnippet,
    inventors: patent.inventor ? [{ name: patent.inventor.trim() }] : undefined,
    assignees: patent.assignee ? [{ name: patent.assignee.trim() }] : undefined,
    filing_date: patent.filing_date || undefined,
    publication_date: patent.publication_date || undefined,
    grant_date: patent.grant_date || undefined,
    priority_date: patent.priority_date || undefined,
    source_adapter: "google-patents-web",
    source_url: sourceUrl,
  };
}

/** `patent/US11741188B2/en` → `US11741188B2`. */
function deriveCanonicalFromId(id: string): string {
  const match = /patent\/([^/]+)/.exec(id);
  return match ? match[1] : id;
}

const TAG_RE = /<[^>]+>/g;
const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&hellip;": "…",
  "&nbsp;": " ",
};

export function stripHtml(input: string): string {
  return input
    .replace(TAG_RE, "")
    .replace(/&(?:amp|lt|gt|quot|#39|hellip|nbsp);/g, (m) => ENTITY_MAP[m] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}
