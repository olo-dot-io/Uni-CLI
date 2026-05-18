/**
 * @owner       src::adapters::cipo::legal-status
 * @does        Browser-driven CIPO legal-status / prosecution timeline lookup; emits the most recent administrative-status field from the CPD admin tab.
 * @needs       src/engine/transport/mcp-browser.ts, src/adapters/cipo/_shared.ts, src/registry.ts
 * @feeds       src/commands/patent.ts (capability tag patent.legal-status)
 * @breaks      PATENT_INVALID_NUMBER, PATENT_NOT_FOUND, PATENT_API_DEPRECATED (MCP_BUS_MISSING)
 * @invariants  output row carries legal_status verbatim as CIPO displayed it
 * @side-effects controls Chrome via MCP
 * @perf        single navigate + evaluate
 * @concurrency safe
 * @test        tests/unit/adapters/cipo/search.test.ts (shared transport-error path)
 * @stability   experimental
 * @since       2026-05-18
 * @verification browser-only
 */

import { cli, Strategy } from "../../registry.js";
import { TransportError } from "../../engine/transport/mcp-browser.js";
import {
  cipoEnvelope,
  cipoNavigateAndExtract,
  transportErrorToCipoEnvelope,
} from "./_shared.js";

const ADAPTER_PATH = "src/adapters/cipo/legal-status.ts";

interface CipoLegalExtract {
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
    publication_number: text('.patent-number, [data-field="patentNo"]'),
    legal_status: text('.admin-status, [data-field="adminStatus"]'),
    status_date: text('.status-date, [data-field="statusDate"]'),
    source_url: location.href,
  };
})()`;

function legalUrlFor(pubNo: string): string {
  const stripped = pubNo.replace(/^CA[-]?/, "");
  return `https://cipo.ic.gc.ca/opic-cipo/cpd/eng/patent/${encodeURIComponent(stripped)}/admin.html`;
}

export async function runCipoLegalStatus(kwargs: {
  publication_number: string;
}): Promise<unknown[]> {
  const pubNo = String(kwargs.publication_number ?? "").trim();
  if (pubNo.length === 0) {
    return [
      {
        envelope: cipoEnvelope(
          "PATENT_INVALID_NUMBER",
          ADAPTER_PATH,
          "validate",
          "cipo legal-status requires a non-empty publication_number",
        ),
      },
    ];
  }
  const url = legalUrlFor(pubNo);
  let detail: CipoLegalExtract;
  try {
    const result = await cipoNavigateAndExtract<CipoLegalExtract>(
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
            "cipo legal-status evaluate returned no data",
          ),
        },
      ];
    }
    detail = result.data;
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
  if (!detail.legal_status) {
    return [
      {
        envelope: cipoEnvelope(
          "PATENT_NOT_FOUND",
          ADAPTER_PATH,
          "evaluate",
          `cipo returned no admin/legal-status for "${pubNo}"`,
          ["uspto", "epo"],
        ),
      },
    ];
  }
  return [
    {
      publication_number: detail.publication_number || pubNo,
      legal_status: detail.legal_status,
      status_date: detail.status_date,
      source_adapter: "cipo",
      source_url: detail.source_url || url,
      retrieved_at: new Date().toISOString(),
    },
  ];
}

cli({
  site: "cipo",
  name: "legal-status",
  description: "CIPO Canadian patent administrative-status lookup (browser)",
  domain: "cipo.ic.gc.ca",
  strategy: Strategy.PUBLIC,
  adapter_path: ADAPTER_PATH,
  args: [
    {
      name: "publication_number",
      type: "str",
      required: true,
      positional: true,
      description: "CA publication number",
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
    runCipoLegalStatus(kwargs as { publication_number: string }),
});
