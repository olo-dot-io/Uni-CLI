/**
 * @owner       src::adapters::fips::search
 * @does        Browser-driven Rospatent FIPS search at www.fips.ru — Russia's federal IP office has no open API; the FIPS portal is the only programmatic surface.
 * @needs       src/engine/transport/mcp-browser.ts, src/engine/normalizer/patent-envelope.ts, src/adapters/fips/_shared.ts, src/registry.ts
 * @feeds       src/commands/patent.ts (capability tag patent.search)
 * @breaks      PATENT_UNSUPPORTED_QUERY (empty), PATENT_NOT_FOUND (no rows), PATENT_API_DEPRECATED with MCP_BUS_MISSING; PATENT_REGION_BLOCKED is also possible if the browser cannot reach .ru
 * @invariants  rows canonicalized into PatentRecord; source_adapter='fips'
 * @side-effects controls Chrome via MCP
 * @perf        single navigate + evaluate
 * @concurrency safe
 * @test        tests/unit/adapters/fips/search.test.ts
 * @stability   experimental
 * @since       2026-05-18
 * @verification browser-only
 */

import { cli, Strategy } from "../../registry.js";
import { TransportError } from "../../engine/transport/mcp-browser.js";
import { assemblePatentRecord } from "../../engine/normalizer/patent-envelope.js";
import {
  fipsEnvelope,
  fipsNavigateAndExtract,
  transportErrorToFipsEnvelope,
} from "./_shared.js";

const ADAPTER_PATH = "src/adapters/fips/search.ts";
const FIPS_SEARCH_URL = "https://www.fips.ru/iiss/search.xhtml";

interface FipsRow {
  publication_number: string;
  title?: string;
  applicant?: string;
  publication_date?: string;
  source_url?: string;
}

const EXTRACTOR = `(() => {
  const rows = Array.from(
    document.querySelectorAll('table.results tr.result-row, .search-results .item')
  ).map((el) => {
    const text = (sel) => {
      const node = el.querySelector(sel);
      return node ? (node.textContent || '').trim() : '';
    };
    const linkEl = el.querySelector('a[href]');
    return {
      publication_number: text('.doc-number, td.number, [data-field="docNumber"]'),
      title: text('.doc-title, td.title, [data-field="title"]'),
      applicant: text('.applicant, td.applicant, [data-field="applicant"]'),
      publication_date: text('.publication-date, td.pubDate, [data-field="pubDate"]'),
      source_url: linkEl ? linkEl.href : '',
    };
  });
  return { rows };
})()`;

function buildSearchUrl(query: string): string {
  const params = new URLSearchParams({ q: query });
  return `${FIPS_SEARCH_URL}?${params.toString()}`;
}

export async function runFipsSearch(kwargs: {
  query: string;
  limit?: number;
}): Promise<unknown[]> {
  const limit =
    typeof kwargs.limit === "number" && Number.isFinite(kwargs.limit)
      ? Math.max(1, Math.min(100, Math.floor(kwargs.limit)))
      : 25;
  const query = String(kwargs.query ?? "").trim();
  if (query.length === 0) {
    return [
      {
        envelope: fipsEnvelope(
          "PATENT_UNSUPPORTED_QUERY",
          ADAPTER_PATH,
          "validate",
          "fips search requires a non-empty query",
        ),
      },
    ];
  }
  const url = buildSearchUrl(query);
  let extract: { rows: FipsRow[] };
  try {
    const result = await fipsNavigateAndExtract<{ rows: FipsRow[] }>(
      url,
      EXTRACTOR,
    );
    if (!result.data) {
      return [
        {
          envelope: fipsEnvelope(
            "PATENT_SCHEMA_DRIFT",
            ADAPTER_PATH,
            "evaluate",
            "fips evaluate returned no data; selectors likely drifted",
          ),
        },
      ];
    }
    extract = result.data;
  } catch (err) {
    if (err instanceof TransportError) {
      return [
        {
          envelope: transportErrorToFipsEnvelope(err, ADAPTER_PATH, "navigate"),
        },
      ];
    }
    throw err;
  }
  if (extract.rows.length === 0) {
    return [
      {
        envelope: fipsEnvelope(
          "PATENT_NOT_FOUND",
          ADAPTER_PATH,
          "evaluate",
          `fips returned no rows for query "${query}"`,
          ["espacenet"],
        ),
      },
    ];
  }
  const out: unknown[] = [];
  for (const row of extract.rows.slice(0, limit)) {
    if (!row.publication_number) continue;
    const normalizedPub = /^RU[-]?/.test(row.publication_number)
      ? row.publication_number
      : `RU${row.publication_number}`;
    try {
      out.push(
        assemblePatentRecord({
          publication_number: normalizedPub,
          title: row.title || undefined,
          assignees: row.applicant
            ? [{ name: row.applicant, country: "RU" }]
            : undefined,
          publication_date: row.publication_date || undefined,
          source_adapter: "fips",
          source_url: row.source_url || url,
        } as Parameters<typeof assemblePatentRecord>[0]),
      );
    } catch {
      // Skip malformed rows.
    }
  }
  if (out.length === 0) {
    out.push({
      envelope: fipsEnvelope(
        "PATENT_NOT_FOUND",
        ADAPTER_PATH,
        "normalize",
        "fips returned rows but none normalized to a valid publication_number",
        ["espacenet"],
      ),
    });
  }
  return out;
}

cli({
  site: "fips",
  name: "search",
  description:
    "Search Rospatent FIPS Russian patent database (browser, no API)",
  domain: "www.fips.ru",
  strategy: Strategy.PUBLIC,
  adapter_path: ADAPTER_PATH,
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "Free-text query for FIPS Russian patent search",
    },
    {
      name: "limit",
      type: "int",
      default: 25,
      description: "Max results (1-100)",
    },
  ],
  columns: ["publication_number", "title", "publication_date", "source_url"],
  capabilities: [
    "mcp-browser.navigate",
    "mcp-browser.evaluate",
    "patent.search",
  ],
  minimum_capability: "mcp-browser.evaluate",
  func: async (_page, kwargs) =>
    runFipsSearch(kwargs as { query: string; limit?: number }),
});
