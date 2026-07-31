/**
 * @owner       src::adapters::cipo::get
 * @does        Browser-driven CIPO single-document retrieval — Canadian Patents Database detail page extracted into a PatentRecord.
 * @needs       src/adapters/_shared/browser-tools.ts, src/engine/normalizer/patent-envelope.ts, src/adapters/cipo/_shared.ts, src/registry.ts
 * @feeds       src/commands/patent.ts (capability tag patent.get)
 * @breaks      PATENT_INVALID_NUMBER, PATENT_NOT_FOUND, PATENT_API_DEPRECATED (browser provider unavailable)
 * @invariants  output row is a canonical PatentRecord
 * @side-effects controls the registry-owned browser page via CDP
 * @perf        single navigate + evaluate
 * @concurrency safe
 * @test        tests/unit/adapters/cipo/search.test.ts (transport-error shared path)
 * @stability   experimental
 * @since       2026-05-18
 * @verification browser-only
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { requireBrowserPage } from "../_shared/browser-tools.js";
import { assemblePatentRecord } from "../../engine/normalizer/patent-envelope.js";
import { cipoEnvelope, cipoNavigateAndExtract } from "./_shared.js";

const ADAPTER_PATH = "src/adapters/cipo/get.ts";

interface CipoDetail {
  publication_number?: string;
  application_number?: string;
  title?: string;
  abstract?: string;
  applicant?: string;
  inventor?: string;
  publication_date?: string;
  filing_date?: string;
  grant_date?: string;
  source_url?: string;
}

const DETAIL_EXTRACTOR = `(() => {
  const text = (sel) => {
    const node = document.querySelector(sel);
    return node ? (node.textContent || '').trim() : '';
  };
  return {
    publication_number: text('.patent-number, [data-field="patentNo"]'),
    application_number: text('.application-number, [data-field="appNo"]'),
    title: text('.patent-title, h1.title, [data-field="title"]'),
    abstract: text('.abstract, [data-field="abstract"]'),
    applicant: text('.applicant-name, [data-field="applicant"]'),
    inventor: text('.inventor-name, [data-field="inventor"]'),
    publication_date: text('.publication-date, [data-field="pubDate"]'),
    filing_date: text('.filing-date, [data-field="filingDate"]'),
    grant_date: text('.grant-date, [data-field="grantDate"]'),
    source_url: location.href,
  };
})()`;

function detailUrlFor(pubNo: string): string {
  const stripped = pubNo.replace(/^CA[-]?/, "");
  return `https://cipo.ic.gc.ca/opic-cipo/cpd/eng/patent/${encodeURIComponent(stripped)}/summary.html`;
}

export async function runCipoGet(
  page: IPage,
  kwargs: {
    publication_number: string;
  },
): Promise<unknown[]> {
  const pubNo = String(kwargs.publication_number ?? "").trim();
  if (pubNo.length === 0) {
    return [
      {
        envelope: cipoEnvelope(
          "PATENT_INVALID_NUMBER",
          ADAPTER_PATH,
          "validate",
          "cipo get requires a non-empty publication_number",
        ),
      },
    ];
  }
  const url = detailUrlFor(pubNo);
  let detail: CipoDetail;
  const result = await cipoNavigateAndExtract<CipoDetail>(
    page,
    url,
    DETAIL_EXTRACTOR,
  );
  if (!result.data) {
    return [
      {
        envelope: cipoEnvelope(
          "PATENT_SCHEMA_DRIFT",
          ADAPTER_PATH,
          "evaluate",
          "cipo detail evaluate returned no data",
        ),
      },
    ];
  }
  detail = result.data;
  if (!detail.publication_number && !detail.title) {
    return [
      {
        envelope: cipoEnvelope(
          "PATENT_NOT_FOUND",
          ADAPTER_PATH,
          "evaluate",
          `cipo detail page for "${pubNo}" yielded no bibliographic fields`,
          ["uspto", "epo"],
        ),
      },
    ];
  }
  const rawPubNo = detail.publication_number || pubNo;
  const canonicalPubNo = /^CA[-]?/.test(rawPubNo) ? rawPubNo : `CA${rawPubNo}`;
  try {
    return [
      assemblePatentRecord({
        publication_number: canonicalPubNo,
        application_number: detail.application_number || undefined,
        title: detail.title || undefined,
        abstract: detail.abstract || undefined,
        assignees: detail.applicant
          ? [{ name: detail.applicant, country: "CA" }]
          : undefined,
        inventors: detail.inventor
          ? [{ name: detail.inventor, country: "CA" }]
          : undefined,
        publication_date: detail.publication_date || undefined,
        filing_date: detail.filing_date || undefined,
        grant_date: detail.grant_date || undefined,
        source_adapter: "cipo",
        source_url: detail.source_url || url,
      } as Parameters<typeof assemblePatentRecord>[0]),
    ];
  } catch {
    return [
      {
        envelope: cipoEnvelope(
          "PATENT_NOT_FOUND",
          ADAPTER_PATH,
          "normalize",
          `cipo detail page for "${pubNo}" did not yield a valid publication_number`,
          ["uspto"],
        ),
      },
    ];
  }
}

cli({
  site: "cipo",
  name: "get",
  description: "Retrieve a single Canadian patent document (CIPO, browser)",
  domain: "cipo.ic.gc.ca",
  strategy: Strategy.PUBLIC,
  adapter_path: ADAPTER_PATH,
  args: [
    {
      name: "publication_number",
      type: "str",
      minLength: 1,
      pattern: "^(?:CA-?)?[A-Z0-9]+-?[A-Z][0-9]?$",
      required: true,
      positional: true,
      description: "CA publication number (with or without CA prefix)",
    },
  ],
  columns: [
    "publication_number",
    "title",
    "publication_date",
    "grant_date",
    "source_url",
  ],
  capabilities: ["cdp-browser.navigate", "cdp-browser.evaluate", "patent.get"],
  minimum_capability: "cdp-browser.evaluate",
  browser: true,
  func: async (page, kwargs) =>
    runCipoGet(
      requireBrowserPage(page),
      kwargs as { publication_number: string },
    ),
});
