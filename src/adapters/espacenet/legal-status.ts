/**
 * @owner       src::adapters::espacenet::legal-status
 * @does        Browser-driven Espacenet legal-status lookup — INPADOC events table on the legal-status tab.
 * @needs       src/engine/transport/mcp-browser.ts, src/adapters/espacenet/_shared.ts, src/registry.ts
 * @feeds       src/commands/patent.ts (capability tag patent.legal-status)
 * @breaks      PATENT_INVALID_NUMBER, PATENT_NOT_FOUND, PATENT_API_DEPRECATED (MCP_BUS_MISSING)
 * @invariants  output row carries legal_status as the most-recent INPADOC event verbatim
 * @side-effects controls Chrome via MCP
 * @perf        single navigate + evaluate
 * @concurrency safe
 * @test        tests/unit/adapters/espacenet/search.test.ts (shared transport-error path)
 * @stability   experimental
 * @since       2026-05-18
 * @verification browser-only
 */

import { cli, Strategy } from "../../registry.js";
import { TransportError } from "../../engine/transport/mcp-browser.js";
import {
  espacenetEnvelope,
  espacenetNavigateAndExtract,
  transportErrorToEspacenetEnvelope,
} from "./_shared.js";

const ADAPTER_PATH = "src/adapters/espacenet/legal-status.ts";

interface EspacenetLegalExtract {
  publication_number?: string;
  legal_status?: string;
  status_date?: string;
  source_url?: string;
}

const EXTRACTOR = `(() => {
  const text = (sel) => {
    const node = document.querySelector(sel);
    return node ? (node.textContent || '').trim() : '';
  };
  return {
    publication_number: text('[data-test="publication-number"], .publicationNumber'),
    legal_status: text('[data-test="legal-status"] tr:first-child td:nth-child(2), .legalStatus__currentStatus'),
    status_date: text('[data-test="legal-status"] tr:first-child td:nth-child(1), .legalStatus__currentDate'),
    source_url: location.href,
  };
})()`;

function legalUrlFor(pubNo: string): string {
  return `https://worldwide.espacenet.com/patent/search/legal-status/${encodeURIComponent(pubNo)}`;
}

export async function runEspacenetLegalStatus(kwargs: {
  publication_number: string;
}): Promise<unknown[]> {
  const pubNo = String(kwargs.publication_number ?? "").trim();
  if (pubNo.length === 0) {
    return [
      {
        envelope: espacenetEnvelope(
          "PATENT_INVALID_NUMBER",
          ADAPTER_PATH,
          "validate",
          "espacenet legal-status requires a non-empty publication_number",
        ),
      },
    ];
  }
  const url = legalUrlFor(pubNo);
  let detail: EspacenetLegalExtract;
  try {
    const result = await espacenetNavigateAndExtract<EspacenetLegalExtract>(
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
            "espacenet legal-status evaluate returned no data",
          ),
        },
      ];
    }
    detail = result.data;
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
  if (!detail.legal_status) {
    return [
      {
        envelope: espacenetEnvelope(
          "PATENT_NOT_FOUND",
          ADAPTER_PATH,
          "evaluate",
          `espacenet returned no legal_status for "${pubNo}"`,
          ["epo"],
        ),
      },
    ];
  }
  return [
    {
      publication_number: detail.publication_number || pubNo,
      legal_status: detail.legal_status,
      status_date: detail.status_date,
      source_adapter: "espacenet",
      source_url: detail.source_url || url,
      retrieved_at: new Date().toISOString(),
    },
  ];
}

cli({
  site: "espacenet",
  name: "legal-status",
  description: "Espacenet INPADOC legal-status lookup (browser)",
  domain: "worldwide.espacenet.com",
  strategy: Strategy.PUBLIC,
  adapter_path: ADAPTER_PATH,
  args: [
    {
      name: "publication_number",
      type: "str",
      required: true,
      positional: true,
      description: "ST.16 publication number",
    },
  ],
  columns: ["publication_number", "legal_status", "status_date", "source_url"],
  capabilities: [
    "mcp-browser.navigate",
    "mcp-browser.evaluate",
    "patent.legal-status",
  ],
  minimum_capability: "mcp-browser.evaluate",
  func: async (_page, kwargs) =>
    runEspacenetLegalStatus(kwargs as { publication_number: string }),
});
