/**
 * @owner       src::adapters::espacenet::get
 * @does        Browser-driven retrieval of a single Espacenet publication detail page; extracts bibliographic fields and emits a PatentRecord.
 * @needs       src/adapters/_shared/browser-tools.ts, src/engine/normalizer/patent-envelope.ts, src/adapters/espacenet/_shared.ts, src/registry.ts
 * @feeds       src/commands/patent.ts (capability tag patent.get)
 * @breaks      PATENT_INVALID_NUMBER, PATENT_NOT_FOUND, PATENT_API_DEPRECATED with browser provider unavailable
 * @invariants  output is a single PatentRecord row when upstream answers; never returns a stub
 * @side-effects controls the registry-owned browser page via CDP
 * @perf        single navigate + evaluate
 * @concurrency safe
 * @test        tests/unit/adapters/espacenet/search.test.ts (transport-error path)
 * @stability   experimental
 * @since       2026-05-18
 * @verification browser-only
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { requireBrowserPage } from "../_shared/browser-tools.js";
import { assemblePatentRecord } from "../../engine/normalizer/patent-envelope.js";
import { espacenetEnvelope, espacenetNavigateAndExtract } from "./_shared.js";

const ADAPTER_PATH = "src/adapters/espacenet/get.ts";

interface EspacenetDetail {
  publication_number?: string;
  application_number?: string;
  title?: string;
  abstract?: string;
  applicant?: string;
  inventor?: string;
  publication_date?: string;
  filing_date?: string;
  source_url?: string;
  html_marker?: string;
}

const DETAIL_EXTRACTOR = `(() => {
  const text = (sel) => {
    const node = document.querySelector(sel);
    return node ? (node.textContent || '').trim() : '';
  };
  return {
    publication_number: text('[data-test="publication-number"], .publicationNumber'),
    application_number: text('[data-test="application-number"], .applicationNumber'),
    title: text('[data-test="title"], h1.title, .invention-title'),
    abstract: text('[data-test="abstract"], .abstract'),
    applicant: text('[data-test="applicant"], .applicantName'),
    inventor: text('[data-test="inventor"], .inventorName'),
    publication_date: text('[data-test="publication-date"], .publicationDate'),
    filing_date: text('[data-test="filing-date"], .filingDate'),
    source_url: location.href,
    html_marker: document.body && document.body.innerText
      ? document.body.innerText.slice(0, 200)
      : '',
  };
})()`;

function detailUrlFor(pubNo: string): string {
  return `https://worldwide.espacenet.com/patent/search/publication/${encodeURIComponent(pubNo)}`;
}

export async function runEspacenetGet(
  page: IPage,
  kwargs: {
    publication_number: string;
  },
): Promise<unknown[]> {
  const pubNo = String(kwargs.publication_number ?? "").trim();
  if (pubNo.length === 0) {
    return [
      {
        envelope: espacenetEnvelope(
          "PATENT_INVALID_NUMBER",
          ADAPTER_PATH,
          "validate",
          "espacenet get requires a non-empty publication_number",
        ),
      },
    ];
  }
  const url = detailUrlFor(pubNo);
  let detail: EspacenetDetail;
  const result = await espacenetNavigateAndExtract<EspacenetDetail>(
    page,
    url,
    DETAIL_EXTRACTOR,
  );
  if (!result.data) {
    return [
      {
        envelope: espacenetEnvelope(
          "PATENT_SCHEMA_DRIFT",
          ADAPTER_PATH,
          "evaluate",
          "espacenet detail evaluate returned no data",
        ),
      },
    ];
  }
  detail = result.data;
  const fieldCount = [detail.publication_number, detail.title].filter(
    Boolean,
  ).length;
  if (fieldCount === 0) {
    return [
      {
        envelope: espacenetEnvelope(
          "PATENT_NOT_FOUND",
          ADAPTER_PATH,
          "evaluate",
          `espacenet detail page for "${pubNo}" yielded no bibliographic fields`,
          ["epo", "uspto"],
        ),
      },
    ];
  }
  const canonicalPubNo = detail.publication_number || pubNo;
  try {
    return [
      assemblePatentRecord({
        publication_number: canonicalPubNo,
        application_number: detail.application_number || undefined,
        title: detail.title || undefined,
        abstract: detail.abstract || undefined,
        assignees: detail.applicant ? [{ name: detail.applicant }] : undefined,
        inventors: detail.inventor ? [{ name: detail.inventor }] : undefined,
        publication_date: detail.publication_date || undefined,
        filing_date: detail.filing_date || undefined,
        source_adapter: "espacenet",
        source_url: detail.source_url || url,
      } as Parameters<typeof assemblePatentRecord>[0]),
    ];
  } catch {
    return [
      {
        envelope: espacenetEnvelope(
          "PATENT_NOT_FOUND",
          ADAPTER_PATH,
          "normalize",
          `espacenet detail page for "${pubNo}" did not yield a valid publication_number`,
          ["epo"],
        ),
      },
    ];
  }
}

cli({
  site: "espacenet",
  name: "get",
  description:
    "Retrieve a single Espacenet publication detail (browser, no key)",
  domain: "worldwide.espacenet.com",
  strategy: Strategy.PUBLIC,
  adapter_path: ADAPTER_PATH,
  args: [
    {
      name: "publication_number",
      type: "str",
      minLength: 1,
      pattern: "^[A-Z]{2}-?[A-Z0-9]+-?[A-Z][0-9]?$",
      required: true,
      positional: true,
      description: "ST.16 publication number (e.g. EP4123456A1)",
    },
  ],
  columns: ["publication_number", "title", "publication_date", "source_url"],
  capabilities: ["cdp-browser.navigate", "cdp-browser.evaluate", "patent.get"],
  minimum_capability: "cdp-browser.evaluate",
  browser: true,
  func: async (page, kwargs) =>
    runEspacenetGet(
      requireBrowserPage(page),
      kwargs as { publication_number: string },
    ),
});
