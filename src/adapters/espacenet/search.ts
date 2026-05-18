/**
 * @owner       src::adapters::espacenet::search
 * @does        Browser-driven Espacenet front-end search at worldwide.espacenet.com/patent/search — the EPO public no-key fallback for global patent search; complements the keyed EPO OPS adapter at src/adapters/epo/*.
 * @needs       src/engine/transport/mcp-browser.ts, src/engine/normalizer/patent-envelope.ts, src/adapters/espacenet/_shared.ts, src/registry.ts
 * @feeds       src/commands/patent.ts (capability tag patent.search)
 * @breaks      PATENT_API_DEPRECATED with MCP_BUS_MISSING when no outbound MCP transport; PATENT_NOT_FOUND on empty result; PATENT_BROWSER_CAPTCHA on EPO's anti-bot challenge
 * @invariants  output rows are canonical PatentRecord; source_adapter='espacenet'
 * @side-effects controls Chrome via MCP
 * @perf        single navigate + evaluate
 * @concurrency safe
 * @test        tests/unit/adapters/espacenet/search.test.ts
 * @stability   experimental
 * @since       2026-05-18
 * @verification browser-only (distinct from EPO OPS which is keyed REST)
 */

import { cli, Strategy } from "../../registry.js";
import { TransportError } from "../../engine/transport/mcp-browser.js";
import { assemblePatentRecord } from "../../engine/normalizer/patent-envelope.js";
import {
  espacenetEnvelope,
  espacenetNavigateAndExtract,
  transportErrorToEspacenetEnvelope,
} from "./_shared.js";

const ADAPTER_PATH = "src/adapters/espacenet/search.ts";
const ESPACENET_SEARCH_URL = "https://worldwide.espacenet.com/patent/search";

interface EspacenetRow {
  publication_number: string;
  title?: string;
  applicant?: string;
  inventor?: string;
  publication_date?: string;
  source_url?: string;
}

const EXTRACTOR = `(() => {
  const rows = Array.from(
    document.querySelectorAll('article.publication, .item--ezfpdY, [data-test="result"]')
  ).map((el) => {
    const text = (sel) => {
      const node = el.querySelector(sel);
      return node ? (node.textContent || '').trim() : '';
    };
    const linkEl = el.querySelector('a[href*="/patent/search/family"], a[href*="/patent/search/publication"], a[href]');
    return {
      publication_number: text('[data-test="publication-number"], .publicationNumber, .publication__id'),
      title: text('[data-test="title"], .publicationTitle, h3'),
      applicant: text('[data-test="applicant"], .applicantName'),
      inventor: text('[data-test="inventor"], .inventorName'),
      publication_date: text('[data-test="publication-date"], .publicationDate, .publication__date'),
      source_url: linkEl ? linkEl.href : '',
    };
  });
  const html_marker = (document.body && document.body.innerText
    ? document.body.innerText.slice(0, 200)
    : '');
  return { rows, html_marker };
})()`;

interface EspacenetExtractResult {
  rows: EspacenetRow[];
  html_marker?: string;
}

function buildSearchUrl(query: string, limit: number): string {
  // Espacenet smart-search query — `q` is the CQL-lite syntax accepted by
  // the front-end search box. Limit is enforced client-side; Espacenet
  // paginates server-side via the `?p=` page parameter.
  const params = new URLSearchParams({ q: query });
  // Espacenet shows ~25 rows per page; cap requested limit at one page so
  // the browser does not paginate by default.
  if (limit > 25) params.set("ps", String(Math.min(100, limit)));
  return `${ESPACENET_SEARCH_URL}?${params.toString()}`;
}

export async function runEspacenetSearch(kwargs: {
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
        envelope: espacenetEnvelope(
          "PATENT_UNSUPPORTED_QUERY",
          ADAPTER_PATH,
          "validate",
          "espacenet search requires a non-empty query",
        ),
      },
    ];
  }
  const url = buildSearchUrl(query, limit);
  let extract: EspacenetExtractResult;
  try {
    const result = await espacenetNavigateAndExtract<EspacenetExtractResult>(
      url,
      EXTRACTOR,
    );
    if (!result.data) {
      return [
        {
          envelope: espacenetEnvelope(
            "PATENT_SCHEMA_DRIFT",
            ADAPTER_PATH,
            "evaluate",
            "espacenet evaluate returned no data; selector schema likely changed",
          ),
        },
      ];
    }
    extract = result.data;
  } catch (err) {
    if (err instanceof TransportError) {
      return [
        {
          envelope: transportErrorToEspacenetEnvelope(
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
    const marker = (extract.html_marker ?? "").toLowerCase();
    if (
      marker.includes("captcha") ||
      marker.includes("challenge") ||
      marker.includes("are you a human")
    ) {
      return [
        {
          envelope: espacenetEnvelope(
            "PATENT_BROWSER_CAPTCHA",
            ADAPTER_PATH,
            "evaluate",
            "espacenet served an anti-bot challenge; solve it in the open browser tab and re-run",
            ["epo"],
          ),
        },
      ];
    }
    return [
      {
        envelope: espacenetEnvelope(
          "PATENT_NOT_FOUND",
          ADAPTER_PATH,
          "evaluate",
          `espacenet returned no rows for query "${query}"`,
          ["epo", "uspto"],
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
          title: row.title || undefined,
          assignees: row.applicant ? [{ name: row.applicant }] : undefined,
          inventors: row.inventor ? [{ name: row.inventor }] : undefined,
          publication_date: row.publication_date || undefined,
          source_adapter: "espacenet",
          source_url: row.source_url || url,
        } as Parameters<typeof assemblePatentRecord>[0]),
      );
    } catch {
      // Skip rows that fail canonicalization rather than synthesize.
    }
  }
  if (out.length === 0) {
    out.push({
      envelope: espacenetEnvelope(
        "PATENT_NOT_FOUND",
        ADAPTER_PATH,
        "normalize",
        "espacenet returned rows but none carried a valid publication_number",
        ["epo"],
      ),
    });
  }
  return out;
}

cli({
  site: "espacenet",
  name: "search",
  description:
    "Search Espacenet (EPO public no-key front end) for worldwide patents",
  domain: "worldwide.espacenet.com",
  strategy: Strategy.PUBLIC,
  adapter_path: ADAPTER_PATH,
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "Espacenet smart-search query (CQL-lite syntax)",
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
    runEspacenetSearch(kwargs as { query: string; limit?: number }),
});
