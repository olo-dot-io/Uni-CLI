/**
 * @owner       src::adapters::cipo::search
 * @does        Browser-driven search of the Canadian Patents Database at cipo.ic.gc.ca/opic-cipo/cpd/eng/ — CIPO exposes no general open API for the patents corpus, so the browser route is the only programmatic surface.
 * @needs       src/engine/transport/mcp-browser.ts, src/engine/normalizer/patent-envelope.ts, src/adapters/cipo/_shared.ts, src/registry.ts
 * @feeds       src/commands/patent.ts (capability tag patent.search)
 * @breaks      PATENT_UNSUPPORTED_QUERY (empty), PATENT_NOT_FOUND (empty result), PATENT_API_DEPRECATED with MCP_BUS_MISSING (no outbound MCP transport)
 * @invariants  rows are canonical PatentRecord; source_adapter='cipo'
 * @side-effects controls Chrome via MCP
 * @perf        single navigate + evaluate
 * @concurrency safe
 * @test        tests/unit/adapters/cipo/search.test.ts
 * @stability   experimental
 * @since       2026-05-18
 * @verification browser-only
 */

import { cli, Strategy } from "../../registry.js";
import { TransportError } from "../../engine/transport/mcp-browser.js";
import { assemblePatentRecord } from "../../engine/normalizer/patent-envelope.js";
import {
  cipoEnvelope,
  cipoNavigateAndExtract,
  transportErrorToCipoEnvelope,
} from "./_shared.js";

const ADAPTER_PATH = "src/adapters/cipo/search.ts";
const CIPO_SEARCH_URL =
  "https://cipo.ic.gc.ca/opic-cipo/cpd/eng/search/basic.html";

interface CipoRow {
  publication_number: string;
  title?: string;
  applicant?: string;
  publication_date?: string;
  source_url?: string;
}

const EXTRACTOR = `(() => {
  const rows = Array.from(
    document.querySelectorAll('table.results tr.result-row, .search-results .result')
  ).map((el) => {
    const text = (sel) => {
      const node = el.querySelector(sel);
      return node ? (node.textContent || '').trim() : '';
    };
    const linkEl = el.querySelector('a[href*="patent/"], a[href]');
    return {
      publication_number: text('.patent-number, td.patent-no, [data-field="patentNo"]'),
      title: text('.patent-title, td.title, [data-field="title"]'),
      applicant: text('.applicant-name, td.applicant, [data-field="applicant"]'),
      publication_date: text('.publication-date, td.pubDate, [data-field="pubDate"]'),
      source_url: linkEl ? linkEl.href : '',
    };
  });
  return { rows };
})()`;

function buildSearchUrl(query: string): string {
  const params = new URLSearchParams({ search: query });
  return `${CIPO_SEARCH_URL}?${params.toString()}`;
}

export async function runCipoSearch(kwargs: {
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
        envelope: cipoEnvelope(
          "PATENT_UNSUPPORTED_QUERY",
          ADAPTER_PATH,
          "validate",
          "cipo search requires a non-empty query",
        ),
      },
    ];
  }
  const url = buildSearchUrl(query);
  let extract: { rows: CipoRow[] };
  try {
    const result = await cipoNavigateAndExtract<{ rows: CipoRow[] }>(
      url,
      EXTRACTOR,
    );
    if (!result.data) {
      return [
        {
          envelope: cipoEnvelope(
            "PATENT_SCHEMA_DRIFT",
            ADAPTER_PATH,
            "evaluate",
            "cipo evaluate returned no data; selector schema likely changed",
          ),
        },
      ];
    }
    extract = result.data;
  } catch (err) {
    if (err instanceof TransportError) {
      return [
        {
          envelope: transportErrorToCipoEnvelope(err, ADAPTER_PATH, "navigate"),
        },
      ];
    }
    throw err;
  }
  if (extract.rows.length === 0) {
    return [
      {
        envelope: cipoEnvelope(
          "PATENT_NOT_FOUND",
          ADAPTER_PATH,
          "evaluate",
          `cipo returned no rows for query "${query}"`,
          ["uspto", "epo"],
        ),
      },
    ];
  }
  const out: unknown[] = [];
  for (const row of extract.rows.slice(0, limit)) {
    if (!row.publication_number) continue;
    const normalizedPub = /^CA[-]?/.test(row.publication_number)
      ? row.publication_number
      : `CA${row.publication_number}`;
    try {
      out.push(
        assemblePatentRecord({
          publication_number: normalizedPub,
          title: row.title || undefined,
          assignees: row.applicant
            ? [{ name: row.applicant, country: "CA" }]
            : undefined,
          publication_date: row.publication_date || undefined,
          source_adapter: "cipo",
          source_url: row.source_url || url,
        } as Parameters<typeof assemblePatentRecord>[0]),
      );
    } catch {
      // Skip malformed rows.
    }
  }
  if (out.length === 0) {
    out.push({
      envelope: cipoEnvelope(
        "PATENT_NOT_FOUND",
        ADAPTER_PATH,
        "normalize",
        "cipo returned rows but none carried a valid publication_number",
        ["uspto"],
      ),
    });
  }
  return out;
}

cli({
  site: "cipo",
  name: "search",
  description: "Search the Canadian Patents Database (CIPO, browser, no API)",
  domain: "cipo.ic.gc.ca",
  strategy: Strategy.PUBLIC,
  adapter_path: ADAPTER_PATH,
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "Free-text query — matched on title/abstract/applicant",
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
    runCipoSearch(kwargs as { query: string; limit?: number }),
});
