/**
 * @owner       src::adapters::cnipa::search
 * @does        Browser-driven search of CNIPA 公众查询 system at pss-system.cponline.cnipa.gov.cn — the only programmatic route for CN patents (CNIPA has no open API today). Drives a real Chrome session via the mcp-browser transport, extracts result rows, normalizes through assemblePatentRecord.
 * @needs       src/engine/transport/mcp-browser.ts, src/engine/normalizer/patent-envelope.ts, src/types/patent.ts, src/adapters/cnipa/_shared.ts, src/registry.ts
 * @feeds       src/commands/patent.ts (meta-command discovers via patent.search capability tag)
 * @breaks      emits PATENT_BROWSER_CAPTCHA envelope when zero rows return from a navigation that did not error (CNIPA almost always shows a captcha gate); emits PATENT_API_DEPRECATED with MCP_BUS_MISSING context when no outbound MCP transport is registered
 * @invariants  result rows always include source_adapter='cnipa'; publication_number canonicalized via assemblePatentRecord; never returns a synthetic row when extraction fails
 * @side-effects controls the user's Chrome browser via MCP; reads no env vars
 * @perf        single navigation + one evaluate; ~2-5 s wall-clock when active
 * @concurrency safe — every call opens a fresh tab via mcpBrowserNavigate
 * @test        tests/unit/adapters/cnipa/search.test.ts
 * @stability   experimental
 * @since       2026-05-18
 * @verification browser-only — no upstream API; gated on a live mcp-browser transport
 */

import { cli, Strategy } from "../../registry.js";
import { TransportError } from "../../engine/transport/mcp-browser.js";
import { assemblePatentRecord } from "../../engine/normalizer/patent-envelope.js";
import {
  cnipaEnvelope,
  looksLikeCaptcha,
  navigateAndExtract,
  transportErrorToEnvelope,
} from "./_shared.js";

const ADAPTER_PATH = "src/adapters/cnipa/search.ts";
const CNIPA_SEARCH_URL =
  "https://pss-system.cponline.cnipa.gov.cn/conventionalSearch";

interface CnipaRow {
  publication_number: string;
  application_number?: string;
  title?: string;
  applicant?: string;
  publication_date?: string;
  filing_date?: string;
  source_url?: string;
}

interface CnipaExtractResult {
  rows: CnipaRow[];
  html_marker?: string;
}

/**
 * DOM extractor executed inside the page via mcp-browser. The selectors are
 * the documented ones for the CNIPA 公众查询 result table; when CNIPA
 * changes the markup an agent reads the failure envelope and updates the
 * selector here (rule 02 self-repair).
 */
const EXTRACTOR = `(() => {
  const rows = Array.from(
    document.querySelectorAll('table.result-table tbody tr, .result-list .result-item')
  ).map((el) => {
    const text = (sel) => {
      const node = el.querySelector(sel);
      return node ? (node.textContent || '').trim() : '';
    };
    return {
      publication_number: text('.publication-number, [data-field="pubNo"]'),
      application_number: text('.application-number, [data-field="appNo"]'),
      title: text('.title, [data-field="title"]'),
      applicant: text('.applicant, [data-field="applicant"]'),
      publication_date: text('.publication-date, [data-field="pubDate"]'),
      filing_date: text('.filing-date, [data-field="appDate"]'),
      source_url: (el.querySelector('a[href]') || {}).href || '',
    };
  });
  const html_marker = (document.body && document.body.innerText
    ? document.body.innerText.slice(0, 200)
    : '');
  return { rows, html_marker };
})()`;

function buildSearchUrl(query: string, limit: number, offset: number): string {
  const params = new URLSearchParams({
    q: query,
    pageSize: String(limit),
    pageNo: String(Math.floor(offset / Math.max(1, limit)) + 1),
  });
  return `${CNIPA_SEARCH_URL}?${params.toString()}`;
}

export async function runCnipaSearch(kwargs: {
  query: string;
  limit?: number;
  offset?: number;
}): Promise<unknown[]> {
  const limit =
    typeof kwargs.limit === "number" && Number.isFinite(kwargs.limit)
      ? Math.max(1, Math.min(100, Math.floor(kwargs.limit)))
      : 25;
  const offset =
    typeof kwargs.offset === "number" && Number.isFinite(kwargs.offset)
      ? Math.max(0, Math.floor(kwargs.offset))
      : 0;
  const query = String(kwargs.query ?? "").trim();
  if (query.length === 0) {
    return [
      {
        envelope: cnipaEnvelope(
          "PATENT_UNSUPPORTED_QUERY",
          ADAPTER_PATH,
          "validate",
          "cnipa search requires a non-empty query string",
        ),
      },
    ];
  }
  const url = buildSearchUrl(query, limit, offset);
  let extract: CnipaExtractResult;
  try {
    const result = await navigateAndExtract<CnipaExtractResult>(url, EXTRACTOR);
    if (!result.data) {
      return [
        {
          envelope: cnipaEnvelope(
            "PATENT_SCHEMA_DRIFT",
            ADAPTER_PATH,
            "evaluate",
            "mcp-browser evaluate returned no data; check selector schema in src/adapters/cnipa/search.ts",
          ),
        },
      ];
    }
    extract = result.data;
  } catch (err) {
    if (err instanceof TransportError) {
      return [
        {
          envelope: transportErrorToEnvelope(err, ADAPTER_PATH, "navigate"),
        },
      ];
    }
    throw err;
  }

  if (looksLikeCaptcha(extract.rows.length, extract.html_marker)) {
    return [
      {
        envelope: cnipaEnvelope(
          "PATENT_BROWSER_CAPTCHA",
          ADAPTER_PATH,
          "evaluate",
          "CNIPA returned no rows for a non-empty query; solve the 验证码 in the open browser tab and re-run",
          ["espacenet", "lens"],
        ),
      },
    ];
  }

  const out: unknown[] = [];
  for (const row of extract.rows.slice(0, limit)) {
    if (!row.publication_number) continue;
    try {
      out.push(
        assemblePatentRecord({
          publication_number: row.publication_number,
          application_number: row.application_number || undefined,
          title: row.title || undefined,
          assignees: row.applicant
            ? [{ name: row.applicant, country: "CN" }]
            : undefined,
          publication_date: row.publication_date || undefined,
          filing_date: row.filing_date || undefined,
          source_adapter: "cnipa",
          source_url: row.source_url || url,
        } as Parameters<typeof assemblePatentRecord>[0]),
      );
    } catch {
      // Skip malformed row rather than synthesize — rule 02.
    }
  }
  if (out.length === 0) {
    out.push({
      envelope: cnipaEnvelope(
        "PATENT_NOT_FOUND",
        ADAPTER_PATH,
        "normalize",
        "cnipa returned rows but none carried a publication_number; report as schema drift",
        ["espacenet"],
      ),
    });
  }
  return out;
}

cli({
  site: "cnipa",
  name: "search",
  description:
    "Search CNIPA via the public 公众查询 browser interface (no API)",
  domain: "pss-system.cponline.cnipa.gov.cn",
  strategy: Strategy.PUBLIC,
  adapter_path: ADAPTER_PATH,
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "Free-text query — matched against title/abstract/claims",
    },
    {
      name: "limit",
      type: "int",
      default: 25,
      description: "Maximum results to return (1-100)",
    },
    {
      name: "offset",
      type: "int",
      default: 0,
      description: "Result offset for pagination",
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
    runCnipaSearch(
      kwargs as { query: string; limit?: number; offset?: number },
    ),
});
