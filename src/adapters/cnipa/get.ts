/**
 * @owner       src::adapters::cnipa::get
 * @does        Browser-driven retrieval of a single CNIPA patent document by publication number; loads the detail page through the registry-owned browser page and extracts the bibliographic fields into a PatentRecord.
 * @needs       src/adapters/_shared/browser-tools.ts, src/engine/normalizer/patent-envelope.ts, src/adapters/cnipa/_shared.ts, src/registry.ts
 * @feeds       src/commands/patent.ts (capability tag patent.get)
 * @breaks      emits PATENT_INVALID_NUMBER when input is empty or fails canonicalization; emits PATENT_NOT_FOUND when the detail page returns no fields; PATENT_BROWSER_CAPTCHA when the page is captcha-gated; PATENT_API_DEPRECATED with browser provider unavailable context when the declared browser provider is unavailable
 * @invariants  output is a single PatentRecord row when the upstream answers; never falls back to a stub record
 * @side-effects controls the registry-owned browser page via CDP
 * @perf        single navigate + one evaluate
 * @concurrency safe
 * @test        tests/unit/adapters/cnipa/search.test.ts (transport-error path) — get-specific tests deferred to integration
 * @stability   experimental
 * @since       2026-05-18
 * @verification browser-only
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { requireBrowserPage } from "../_shared/browser-tools.js";
import { assemblePatentRecord } from "../../engine/normalizer/patent-envelope.js";
import {
  cnipaEnvelope,
  looksLikeCaptcha,
  navigateAndExtract,
} from "./_shared.js";

const ADAPTER_PATH = "src/adapters/cnipa/get.ts";
const CNIPA_DETAIL_URL =
  "https://pss-system.cponline.cnipa.gov.cn/conventionalDetail";

interface CnipaDetail {
  publication_number?: string;
  application_number?: string;
  title?: string;
  abstract?: string;
  applicant?: string;
  inventor?: string;
  publication_date?: string;
  filing_date?: string;
  grant_date?: string;
  legal_status?: string;
  source_url?: string;
  html_marker?: string;
}

const DETAIL_EXTRACTOR = `(() => {
  const text = (sel) => {
    const node = document.querySelector(sel);
    return node ? (node.textContent || '').trim() : '';
  };
  return {
    publication_number: text('[data-field="pubNo"], .publication-number'),
    application_number: text('[data-field="appNo"], .application-number'),
    title: text('[data-field="title"], h1.title, .invention-title'),
    abstract: text('[data-field="abstract"], .abstract'),
    applicant: text('[data-field="applicant"], .applicant'),
    inventor: text('[data-field="inventor"], .inventor'),
    publication_date: text('[data-field="pubDate"], .publication-date'),
    filing_date: text('[data-field="appDate"], .filing-date'),
    grant_date: text('[data-field="grantDate"], .grant-date'),
    legal_status: text('[data-field="legalStatus"], .legal-status'),
    source_url: location.href,
    html_marker: document.body && document.body.innerText
      ? document.body.innerText.slice(0, 200)
      : '',
  };
})()`;

export async function runCnipaGet(
  page: IPage,
  kwargs: {
    publication_number: string;
  },
): Promise<unknown[]> {
  const pubNo = String(kwargs.publication_number ?? "").trim();
  if (pubNo.length === 0) {
    return [
      {
        envelope: cnipaEnvelope(
          "PATENT_INVALID_NUMBER",
          ADAPTER_PATH,
          "validate",
          "cnipa get requires a non-empty publication_number",
        ),
      },
    ];
  }
  const url = `${CNIPA_DETAIL_URL}?pubNo=${encodeURIComponent(pubNo)}`;
  let detail: CnipaDetail;
  const result = await navigateAndExtract<CnipaDetail>(
    page,
    url,
    DETAIL_EXTRACTOR,
  );
  if (!result.data) {
    return [
      {
        envelope: cnipaEnvelope(
          "PATENT_SCHEMA_DRIFT",
          ADAPTER_PATH,
          "evaluate",
          "managed browser evaluate returned no data; check selector schema in src/adapters/cnipa/get.ts",
        ),
      },
    ];
  }
  detail = result.data;

  // Captcha heuristic: detail page returned without any of the expected
  // bibliographic fields → almost certainly captcha-gated.
  const fieldCount = [
    detail.publication_number,
    detail.title,
    detail.application_number,
    detail.publication_date,
  ].filter(Boolean).length;
  if (looksLikeCaptcha(fieldCount, detail.html_marker)) {
    return [
      {
        envelope: cnipaEnvelope(
          "PATENT_BROWSER_CAPTCHA",
          ADAPTER_PATH,
          "evaluate",
          "CNIPA detail page returned no bibliographic fields; solve the 验证码 in the open browser tab and re-run",
          ["espacenet"],
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
        assignees: detail.applicant
          ? [{ name: detail.applicant, country: "CN" }]
          : undefined,
        inventors: detail.inventor
          ? [{ name: detail.inventor, country: "CN" }]
          : undefined,
        publication_date: detail.publication_date || undefined,
        filing_date: detail.filing_date || undefined,
        grant_date: detail.grant_date || undefined,
        legal_status: detail.legal_status || undefined,
        source_adapter: "cnipa",
        source_url: detail.source_url || url,
      } as Parameters<typeof assemblePatentRecord>[0]),
    ];
  } catch {
    return [
      {
        envelope: cnipaEnvelope(
          "PATENT_NOT_FOUND",
          ADAPTER_PATH,
          "normalize",
          `cnipa detail page did not yield a valid publication_number for "${pubNo}"`,
          ["espacenet"],
        ),
      },
    ];
  }
}

cli({
  site: "cnipa",
  name: "get",
  description: "Retrieve a single CNIPA patent document by publication number",
  domain: "pss-system.cponline.cnipa.gov.cn",
  strategy: Strategy.PUBLIC,
  adapter_path: ADAPTER_PATH,
  args: [
    {
      name: "publication_number",
      type: "str",
      minLength: 1,
      pattern: "^CN-?[A-Z0-9]+-?[A-Z][0-9]?$",
      required: true,
      positional: true,
      description: "ST.16 publication number (e.g. CN114123456A)",
    },
  ],
  columns: [
    "publication_number",
    "title",
    "publication_date",
    "legal_status",
    "source_url",
  ],
  capabilities: ["cdp-browser.navigate", "cdp-browser.evaluate", "patent.get"],
  minimum_capability: "cdp-browser.evaluate",
  browser: true,
  func: async (page, kwargs) =>
    runCnipaGet(
      requireBrowserPage(page),
      kwargs as { publication_number: string },
    ),
});
