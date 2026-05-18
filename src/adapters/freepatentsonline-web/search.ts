/**
 * @owner       src::adapters::freepatentsonline-web::search
 * @does        Keyless patent search via www.freepatentsonline.com's SSR `result.html` listing — older site, still maintained, no JS gate, no auth. Complements google-patents-web as a second day-zero source.
 * @needs       src/adapters/freepatentsonline-web/_shared.ts, src/engine/normalizer/patent-envelope.ts, src/registry.ts
 * @feeds       src/commands/patent.ts (capability tag patent.search)
 * @breaks      PATENT_API_DEPRECATED on non-2xx HTTP; PATENT_NOT_FOUND on empty listing; PATENT_SCHEMA_DRIFT when the listing_table selector no longer matches
 * @invariants  output rows are canonical PatentRecord; publication_number is decoded from the FPO link path (URL-encoded structural signal) — rows whose link does not encode a kind code are dropped, never fabricated
 * @side-effects HTTPS egress to www.freepatentsonline.com only
 * @perf        single page fetch (~50 KB); FPO returns 50 results per page
 * @concurrency safe — stateless
 * @test        verification proof in docs/skills/patent-cookbook.md
 * @stability   experimental
 * @since       2026-05-18
 * @verification keyless-best-effort
 */

import { cli, Strategy } from "../../registry.js";
import { assemblePatentRecord } from "../../engine/normalizer/patent-envelope.js";
import { buildPatentEnvelope } from "../../engine/normalizer/patent-envelope.js";
import {
  FpoHttpError,
  buildFpoSearchUrl,
  fetchFpoHtml,
  parseFpoListing,
} from "./_shared.js";

const ADAPTER_PATH = "src/adapters/freepatentsonline-web/search.ts";

interface SearchArgs {
  query?: unknown;
  limit?: unknown;
}

function clampLimit(raw: unknown): number {
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num) || num <= 0) return 25;
  return Math.min(50, Math.max(1, Math.floor(num)));
}

export async function runFreePatentsOnlineSearch(
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
          suggestion: "freepatentsonline-web search requires a non-empty query",
          alternatives: ["google-patents-web"],
        }),
      },
    ];
  }
  const limit = clampLimit(kwargs.limit);
  const url = buildFpoSearchUrl(query, 1);
  let html: string;
  try {
    html = await fetchFpoHtml(url);
  } catch (err) {
    if (err instanceof FpoHttpError) {
      return [
        {
          envelope: buildPatentEnvelope({
            code:
              err.status === 429
                ? "PATENT_RATE_LIMIT"
                : "PATENT_API_DEPRECATED",
            adapter_path: ADAPTER_PATH,
            step: "fetch",
            suggestion: `FreePatentsOnline returned HTTP ${err.status} for ${err.url}; retry with --sources google-patents-web`,
            alternatives: ["google-patents-web", "espacenet"],
            retryable: err.status === 429,
          }),
        },
      ];
    }
    throw err;
  }

  const rows = parseFpoListing(html);
  if (rows.length === 0) {
    return [
      {
        envelope: buildPatentEnvelope({
          code: html.includes('class="listing_table"')
            ? "PATENT_NOT_FOUND"
            : "PATENT_SCHEMA_DRIFT",
          adapter_path: ADAPTER_PATH,
          step: "select",
          suggestion: html.includes('class="listing_table"')
            ? `freepatentsonline-web returned no listing rows for "${query}"`
            : "freepatentsonline-web no longer ships listing_table — the parseFpoListing extractor needs updating",
          alternatives: ["google-patents-web", "espacenet"],
        }),
      },
    ];
  }

  const out: unknown[] = [];
  for (const row of rows.slice(0, limit)) {
    const canonical = row.publication_number_canonical;
    if (!canonical) {
      // Row's link path did not encode a kind code (e.g. bare US grant
      // number). Skip rather than fabricate.
      continue;
    }
    try {
      out.push(
        assemblePatentRecord({
          publication_number: canonical,
          title: row.title || undefined,
          abstract: row.abstract || undefined,
          source_adapter: "freepatentsonline-web",
          source_url: row.detail_url,
        } as Parameters<typeof assemblePatentRecord>[0]),
      );
    } catch {
      // Defensive: skip rows that fail canonicalisation rather than
      // synthesise.
    }
  }

  if (out.length === 0) {
    return [
      {
        envelope: buildPatentEnvelope({
          code: "PATENT_NOT_FOUND",
          adapter_path: ADAPTER_PATH,
          step: "normalize",
          suggestion: `freepatentsonline-web returned ${rows.length} listing rows but none had a structurally decodable kind code; run \`unicli freepatentsonline-web get <pub_no>\` against an individual hit to retrieve its kind code from the detail page`,
          alternatives: ["google-patents-web", "espacenet"],
        }),
      },
    ];
  }
  return out;
}

cli({
  site: "freepatentsonline-web",
  name: "search",
  description:
    "Keyless FreePatentsOnline search via the public SSR listing (no API key, no Chrome)",
  domain: "www.freepatentsonline.com",
  strategy: Strategy.PUBLIC,
  adapter_path: ADAPTER_PATH,
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "Free-text query (FreePatentsOnline xprtsrch syntax)",
    },
    {
      name: "limit",
      type: "int",
      default: 25,
      description: "Max results to return (1-50, FPO paginates at 50)",
    },
  ],
  columns: ["publication_number", "title", "abstract", "source_url"],
  capabilities: ["http.fetch", "patent.search"],
  minimum_capability: "http.fetch",
  func: async (_page, kwargs) =>
    runFreePatentsOnlineSearch(kwargs as SearchArgs),
});
