/**
 * @owner       src::adapters::inpi-br::search
 * @does        Browser-driven INPI Brasil search at busca.inpi.gov.br/pePI/ — Brazil's patent office has no open API (pre-API status); the public web search is the only programmatic surface.
 * @needs       src/engine/transport/mcp-browser.ts, src/engine/normalizer/patent-envelope.ts, src/adapters/inpi-br/_shared.ts, src/registry.ts
 * @feeds       src/commands/patent.ts (capability tag patent.search)
 * @breaks      PATENT_UNSUPPORTED_QUERY (empty), PATENT_NOT_FOUND (no rows), PATENT_API_DEPRECATED with MCP_BUS_MISSING
 * @invariants  output rows canonicalized into PatentRecord with source_adapter='inpi-br'
 * @side-effects controls Chrome via MCP
 * @perf        single navigate + evaluate
 * @concurrency safe
 * @test        tests/unit/adapters/inpi-br/search.test.ts
 * @stability   experimental
 * @since       2026-05-18
 * @verification browser-only
 */

import { cli, Strategy } from "../../registry.js";
import { TransportError } from "../../engine/transport/mcp-browser.js";
import { assemblePatentRecord } from "../../engine/normalizer/patent-envelope.js";
import {
  inpiBrEnvelope,
  inpiBrNavigateAndExtract,
  transportErrorToInpiBrEnvelope,
} from "./_shared.js";

const ADAPTER_PATH = "src/adapters/inpi-br/search.ts";
const INPI_BR_SEARCH_URL =
  "https://busca.inpi.gov.br/pePI/servlet/PatenteServletController";

interface InpiBrRow {
  publication_number: string;
  title?: string;
  applicant?: string;
  publication_date?: string;
  filing_date?: string;
  source_url?: string;
}

const EXTRACTOR = `(() => {
  const rows = Array.from(
    document.querySelectorAll('table.tabela tr.linha, table tr[bgcolor]')
  ).map((el) => {
    const text = (sel) => {
      const node = el.querySelector(sel);
      return node ? (node.textContent || '').trim() : '';
    };
    const cells = Array.from(el.querySelectorAll('td')).map((td) => (td.textContent || '').trim());
    const linkEl = el.querySelector('a[href]');
    return {
      publication_number: text('td.num-pedido, td:first-child') || (cells[0] || ''),
      title: text('td.titulo, td:nth-child(3)') || (cells[2] || ''),
      applicant: text('td.depositante, td:nth-child(4)') || (cells[3] || ''),
      publication_date: text('td.data-pub, td:nth-child(5)') || (cells[4] || ''),
      filing_date: text('td.data-dep, td:nth-child(2)') || (cells[1] || ''),
      source_url: linkEl ? linkEl.href : '',
    };
  });
  return { rows };
})()`;

function buildSearchUrl(query: string): string {
  const params = new URLSearchParams({
    Action: "searchPatente",
    ExpressaoPesquisa: query,
  });
  return `${INPI_BR_SEARCH_URL}?${params.toString()}`;
}

export async function runInpiBrSearch(kwargs: {
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
        envelope: inpiBrEnvelope(
          "PATENT_UNSUPPORTED_QUERY",
          ADAPTER_PATH,
          "validate",
          "inpi-br search requires a non-empty query",
        ),
      },
    ];
  }
  const url = buildSearchUrl(query);
  let extract: { rows: InpiBrRow[] };
  try {
    const result = await inpiBrNavigateAndExtract<{ rows: InpiBrRow[] }>(
      url,
      EXTRACTOR,
    );
    if (!result.data) {
      return [
        {
          envelope: inpiBrEnvelope(
            "PATENT_SCHEMA_DRIFT",
            ADAPTER_PATH,
            "evaluate",
            "inpi-br evaluate returned no data; selectors likely drifted",
          ),
        },
      ];
    }
    extract = result.data;
  } catch (err) {
    if (err instanceof TransportError) {
      return [
        {
          envelope: transportErrorToInpiBrEnvelope(
            err,
            ADAPTER_PATH,
            "navigate",
          ),
        },
      ];
    }
    throw err;
  }
  if (extract.rows.length === 0) {
    return [
      {
        envelope: inpiBrEnvelope(
          "PATENT_NOT_FOUND",
          ADAPTER_PATH,
          "evaluate",
          `inpi-br returned no rows for query "${query}"`,
          ["espacenet", "lens"],
        ),
      },
    ];
  }
  const out: unknown[] = [];
  for (const row of extract.rows.slice(0, limit)) {
    if (!row.publication_number) continue;
    const normalizedPub = /^BR[-]?/.test(row.publication_number)
      ? row.publication_number
      : `BR${row.publication_number}`;
    try {
      out.push(
        assemblePatentRecord({
          publication_number: normalizedPub,
          title: row.title || undefined,
          assignees: row.applicant
            ? [{ name: row.applicant, country: "BR" }]
            : undefined,
          publication_date: row.publication_date || undefined,
          filing_date: row.filing_date || undefined,
          source_adapter: "inpi-br",
          source_url: row.source_url || url,
        } as Parameters<typeof assemblePatentRecord>[0]),
      );
    } catch {
      // Skip malformed rows.
    }
  }
  if (out.length === 0) {
    out.push({
      envelope: inpiBrEnvelope(
        "PATENT_NOT_FOUND",
        ADAPTER_PATH,
        "normalize",
        "inpi-br returned rows but none normalized to a valid publication_number",
        ["espacenet"],
      ),
    });
  }
  return out;
}

cli({
  site: "inpi-br",
  name: "search",
  description: "Search INPI Brasil patents (browser-only, no upstream API)",
  domain: "busca.inpi.gov.br",
  strategy: Strategy.PUBLIC,
  adapter_path: ADAPTER_PATH,
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "Free-text query for INPI Brasil patent search",
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
    runInpiBrSearch(kwargs as { query: string; limit?: number }),
});
