/**
 * @owner       src::adapters::fips::get
 * @does        Browser-driven Rospatent FIPS single-document retrieval at www.fips.ru — extracts the bibliographic block from the document detail page.
 * @needs       src/engine/transport/mcp-browser.ts, src/engine/normalizer/patent-envelope.ts, src/adapters/fips/_shared.ts, src/registry.ts
 * @feeds       src/commands/patent.ts (capability tag patent.get)
 * @breaks      PATENT_INVALID_NUMBER, PATENT_NOT_FOUND, PATENT_API_DEPRECATED with MCP_BUS_MISSING, PATENT_REGION_BLOCKED when .ru is unreachable
 * @invariants  output row is a canonical PatentRecord
 * @side-effects controls Chrome via MCP
 * @perf        single navigate + evaluate
 * @concurrency safe
 * @test        tests/unit/adapters/fips/search.test.ts (shared transport-error path)
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

const ADAPTER_PATH = "src/adapters/fips/get.ts";

interface FipsDetail {
  publication_number?: string;
  application_number?: string;
  title?: string;
  abstract?: string;
  applicant?: string;
  inventor?: string;
  publication_date?: string;
  filing_date?: string;
  source_url?: string;
}

const DETAIL_EXTRACTOR = `(() => {
  const text = (sel) => {
    const node = document.querySelector(sel);
    return node ? (node.textContent || '').trim() : '';
  };
  return {
    publication_number: text('.doc-number, [data-field="docNumber"]'),
    application_number: text('.app-number, [data-field="appNumber"]'),
    title: text('.doc-title, h1.title, [data-field="title"]'),
    abstract: text('.abstract, [data-field="abstract"]'),
    applicant: text('.applicant, [data-field="applicant"]'),
    inventor: text('.inventor, [data-field="inventor"]'),
    publication_date: text('.publication-date, [data-field="pubDate"]'),
    filing_date: text('.filing-date, [data-field="filingDate"]'),
    source_url: location.href,
  };
})()`;

function detailUrlFor(pubNo: string): string {
  const stripped = pubNo.replace(/^RU[-]?/, "");
  const params = new URLSearchParams({ DB: "RUPAT", DocNumber: stripped });
  return `https://www1.fips.ru/fips_servl/fips_servlet?${params.toString()}`;
}

export async function runFipsGet(kwargs: {
  publication_number: string;
}): Promise<unknown[]> {
  const pubNo = String(kwargs.publication_number ?? "").trim();
  if (pubNo.length === 0) {
    return [
      {
        envelope: fipsEnvelope(
          "PATENT_INVALID_NUMBER",
          ADAPTER_PATH,
          "validate",
          "fips get requires a non-empty publication_number",
        ),
      },
    ];
  }
  const url = detailUrlFor(pubNo);
  let detail: FipsDetail;
  try {
    const result = await fipsNavigateAndExtract<FipsDetail>(
      url,
      DETAIL_EXTRACTOR,
    );
    if (!result.data) {
      return [
        {
          envelope: fipsEnvelope(
            "PATENT_SCHEMA_DRIFT",
            ADAPTER_PATH,
            "evaluate",
            "fips detail evaluate returned no data",
          ),
        },
      ];
    }
    detail = result.data;
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
  if (!detail.publication_number && !detail.title) {
    return [
      {
        envelope: fipsEnvelope(
          "PATENT_NOT_FOUND",
          ADAPTER_PATH,
          "evaluate",
          `fips detail page for "${pubNo}" yielded no bibliographic fields`,
          ["espacenet"],
        ),
      },
    ];
  }
  const rawPubNo = detail.publication_number || pubNo;
  const canonicalPubNo = /^RU[-]?/.test(rawPubNo) ? rawPubNo : `RU${rawPubNo}`;
  try {
    return [
      assemblePatentRecord({
        publication_number: canonicalPubNo,
        application_number: detail.application_number || undefined,
        title: detail.title || undefined,
        abstract: detail.abstract || undefined,
        assignees: detail.applicant
          ? [{ name: detail.applicant, country: "RU" }]
          : undefined,
        inventors: detail.inventor
          ? [{ name: detail.inventor, country: "RU" }]
          : undefined,
        publication_date: detail.publication_date || undefined,
        filing_date: detail.filing_date || undefined,
        source_adapter: "fips",
        source_url: detail.source_url || url,
      } as Parameters<typeof assemblePatentRecord>[0]),
    ];
  } catch {
    return [
      {
        envelope: fipsEnvelope(
          "PATENT_NOT_FOUND",
          ADAPTER_PATH,
          "normalize",
          `fips detail page for "${pubNo}" did not yield a valid publication_number`,
          ["espacenet"],
        ),
      },
    ];
  }
}

cli({
  site: "fips",
  name: "get",
  description: "Retrieve a single Rospatent FIPS document (browser-only)",
  domain: "www.fips.ru",
  strategy: Strategy.PUBLIC,
  adapter_path: ADAPTER_PATH,
  args: [
    {
      name: "publication_number",
      type: "str",
      required: true,
      positional: true,
      description: "Russian patent publication number",
    },
  ],
  columns: [
    "publication_number",
    "title",
    "publication_date",
    "filing_date",
    "source_url",
  ],
  capabilities: ["mcp-browser.navigate", "mcp-browser.evaluate", "patent.get"],
  minimum_capability: "mcp-browser.evaluate",
  func: async (_page, kwargs) =>
    runFipsGet(kwargs as { publication_number: string }),
});
