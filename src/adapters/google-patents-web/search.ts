/**
 * @owner       src::adapters::google-patents-web::search
 * @does        Keyless free-text patent search via the public XHR endpoint that drives patents.google.com — distinct from src/adapters/google-patents-bq which talks to BigQuery and needs a billed GCP project.
 * @needs       src/adapters/google-patents-web/_shared.ts, src/engine/normalizer/patent-envelope.ts, src/registry.ts
 * @feeds       src/commands/patent.ts (capability tag patent.search)
 * @breaks      PATENT_API_DEPRECATED with status code embedded when the XHR returns non-2xx (typically 403 → suspected UA gating); PATENT_NOT_FOUND on empty result; PATENT_SCHEMA_DRIFT when the JSON shape no longer carries results.cluster[].result[]
 * @invariants  output rows are canonical PatentRecord; source_adapter='google-patents-web'; results are server-ordered (Google's relevance ranking)
 * @side-effects HTTPS egress to patents.google.com only — no env reads, no cookies, no auth
 * @perf        single XHR request, ~40-100 KB; results capped at min(limit, 100) per call
 * @concurrency safe — stateless
 * @test        verification proof captured in docs/skills/patent-cookbook.md (recipe: day-zero search)
 * @stability   experimental
 * @since       2026-05-18
 * @verification keyless-best-effort — Google does not publish a stability contract for this XHR; we live-call it from the same User-Agent the public site uses
 */

import { cli, Strategy } from "../../registry.js";
import { assemblePatentRecord } from "../../engine/normalizer/patent-envelope.js";
import { buildPatentEnvelope } from "../../engine/normalizer/patent-envelope.js";
import {
  GooglePatentsHttpError,
  buildGooglePatentsXhrUrl,
  fetchGooglePatentsJson,
  flattenGoogleXhrResults,
  projectGoogleRowToRecord,
  type GoogleXhrResponse,
} from "./_shared.js";

const ADAPTER_PATH = "src/adapters/google-patents-web/search.ts";

interface SearchArgs {
  query?: unknown;
  limit?: unknown;
  since?: unknown;
}

function clampLimit(raw: unknown): number {
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num) || num <= 0) return 25;
  return Math.min(100, Math.max(1, Math.floor(num)));
}

function normaliseSince(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return /^\d{4}$/.test(trimmed) ? trimmed : undefined;
}

export async function runGooglePatentsWebSearch(
  kwargs: SearchArgs,
): Promise<unknown[]> {
  const query = String(kwargs.query ?? "").trim();
  if (query.length === 0) {
    return [
      {
        envelope: buildPatentEnvelope({
          code: "PATENT_UNSUPPORTED_QUERY",
          adapter_path: ADAPTER_PATH,
          step: "validate",
          suggestion: "google-patents-web search requires a non-empty query",
          alternatives: ["freepatentsonline-web"],
        }),
      },
    ];
  }
  const limit = clampLimit(kwargs.limit);
  const since = normaliseSince(kwargs.since);
  const url = buildGooglePatentsXhrUrl(query, limit, since);

  let body: GoogleXhrResponse;
  try {
    body = await fetchGooglePatentsJson<GoogleXhrResponse>(url);
  } catch (err) {
    if (err instanceof GooglePatentsHttpError) {
      return [
        {
          envelope: buildPatentEnvelope({
            code:
              err.status === 429
                ? "PATENT_RATE_LIMIT"
                : err.status === 403
                  ? "PATENT_REGION_BLOCKED"
                  : "PATENT_API_DEPRECATED",
            adapter_path: ADAPTER_PATH,
            step: "fetch",
            suggestion: `Google Patents XHR returned HTTP ${err.status} for ${err.url}; retry with --sources freepatentsonline-web, or check if Google now requires a session cookie`,
            alternatives: ["freepatentsonline-web", "espacenet"],
            retryable: err.status === 429,
          }),
        },
      ];
    }
    throw err;
  }

  const rows = flattenGoogleXhrResults(body);
  if (rows.length === 0) {
    if (!body.results || !Array.isArray(body.results.cluster)) {
      return [
        {
          envelope: buildPatentEnvelope({
            code: "PATENT_SCHEMA_DRIFT",
            adapter_path: ADAPTER_PATH,
            step: "select",
            suggestion:
              "Google Patents XHR no longer carries results.cluster[].result[]; the adapter's flattenGoogleXhrResults projection needs updating",
            alternatives: ["freepatentsonline-web"],
          }),
        },
      ];
    }
    return [
      {
        envelope: buildPatentEnvelope({
          code: "PATENT_NOT_FOUND",
          adapter_path: ADAPTER_PATH,
          step: "select",
          suggestion: `google-patents-web returned no rows for "${query}"`,
          alternatives: ["freepatentsonline-web", "espacenet"],
        }),
      },
    ];
  }

  const out: unknown[] = [];
  for (const row of rows.slice(0, limit)) {
    const partial = projectGoogleRowToRecord(row, url);
    if (!partial.publication_number) continue;
    try {
      out.push(
        assemblePatentRecord(
          partial as Parameters<typeof assemblePatentRecord>[0],
        ),
      );
    } catch {
      // Rows whose publication_number cannot be canonicalised are skipped
      // rather than synthesised — we never invent ST.16 fields.
    }
  }
  if (out.length === 0) {
    return [
      {
        envelope: buildPatentEnvelope({
          code: "PATENT_NOT_FOUND",
          adapter_path: ADAPTER_PATH,
          step: "normalize",
          suggestion: `google-patents-web returned ${rows.length} rows but none carried a canonicalisable publication_number`,
          alternatives: ["freepatentsonline-web", "espacenet"],
        }),
      },
    ];
  }
  return out;
}

cli({
  site: "google-patents-web",
  name: "search",
  description:
    "Keyless Google Patents search via the public XHR endpoint (no API key, no Chrome required)",
  domain: "patents.google.com",
  strategy: Strategy.PUBLIC,
  adapter_path: ADAPTER_PATH,
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "Free-text query (Google Patents smart-search syntax)",
    },
    {
      name: "limit",
      type: "int",
      default: 25,
      description: "Max results to return (1-100)",
    },
    {
      name: "since",
      type: "str",
      description:
        "Earliest publication year (YYYY); translated to after:publication:YYYY0101",
    },
  ],
  columns: [
    "publication_number",
    "title",
    "publication_date",
    "assignees",
    "source_url",
  ],
  capabilities: ["http.fetch", "patent.search"],
  minimum_capability: "http.fetch",
  func: async (_page, kwargs) =>
    runGooglePatentsWebSearch(kwargs as SearchArgs),
});
