/**
 * @owner       src::adapters::cnipa::legal-status
 * @does        Browser-driven CNIPA legal-status lookup — scrapes the prosecution timeline + grant status from the 公众查询 detail page; emits structured envelopes for captcha / not-found / MCP-bus gaps.
 * @needs       src/adapters/_shared/browser-tools.ts, src/engine/normalizer/patent-envelope.ts, src/adapters/cnipa/_shared.ts, src/registry.ts
 * @feeds       src/commands/patent.ts (capability tag patent.legal-status)
 * @breaks      emits PATENT_INVALID_NUMBER, PATENT_BROWSER_CAPTCHA, PATENT_API_DEPRECATED (with browser provider unavailable context); never synthesizes a status
 * @invariants  output row carries `legal_status` exactly as scraped; no normalization beyond trim
 * @side-effects controls the registry-owned browser page via CDP
 * @perf        single navigate + evaluate
 * @concurrency safe
 * @test        tests/unit/adapters/cnipa/search.test.ts (shared transport-error path)
 * @stability   experimental
 * @since       2026-05-18
 * @verification browser-only
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { requireBrowserPage } from "../_shared/browser-tools.js";
import {
  cnipaEnvelope,
  looksLikeCaptcha,
  navigateAndExtract,
} from "./_shared.js";

const ADAPTER_PATH = "src/adapters/cnipa/legal-status.ts";
const CNIPA_LEGAL_URL = "https://pss-system.cponline.cnipa.gov.cn/legalStatus";

interface CnipaLegalRow {
  publication_number: string;
  legal_status?: string;
  status_date?: string;
  source_url?: string;
  html_marker?: string;
}

const EXTRACTOR = `(() => {
  const text = (sel) => {
    const node = document.querySelector(sel);
    return node ? (node.textContent || '').trim() : '';
  };
  return {
    publication_number: text('[data-field="pubNo"], .publication-number'),
    legal_status: text('[data-field="legalStatus"], .legal-status'),
    status_date: text('[data-field="statusDate"], .status-date'),
    source_url: location.href,
    html_marker: document.body && document.body.innerText
      ? document.body.innerText.slice(0, 200)
      : '',
  };
})()`;

export async function runCnipaLegalStatus(
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
          "cnipa legal-status requires a non-empty publication_number",
        ),
      },
    ];
  }
  const url = `${CNIPA_LEGAL_URL}?pubNo=${encodeURIComponent(pubNo)}`;
  let detail: CnipaLegalRow;
  const result = await navigateAndExtract<CnipaLegalRow>(page, url, EXTRACTOR);
  if (!result.data) {
    return [
      {
        envelope: cnipaEnvelope(
          "PATENT_SCHEMA_DRIFT",
          ADAPTER_PATH,
          "evaluate",
          "managed browser evaluate returned no data",
        ),
      },
    ];
  }
  detail = result.data;
  const fieldCount = [detail.publication_number, detail.legal_status].filter(
    Boolean,
  ).length;
  if (looksLikeCaptcha(fieldCount, detail.html_marker)) {
    return [
      {
        envelope: cnipaEnvelope(
          "PATENT_BROWSER_CAPTCHA",
          ADAPTER_PATH,
          "evaluate",
          "CNIPA legal-status page returned no fields; solve the 验证码 and re-run",
          ["espacenet"],
        ),
      },
    ];
  }
  if (!detail.legal_status) {
    return [
      {
        envelope: cnipaEnvelope(
          "PATENT_NOT_FOUND",
          ADAPTER_PATH,
          "normalize",
          `cnipa returned no legal_status for "${pubNo}"`,
          ["espacenet"],
        ),
      },
    ];
  }
  return [
    {
      publication_number: detail.publication_number || pubNo,
      legal_status: detail.legal_status,
      status_date: detail.status_date,
      source_adapter: "cnipa",
      source_url: detail.source_url || url,
      retrieved_at: new Date().toISOString(),
    },
  ];
}

cli({
  site: "cnipa",
  name: "legal-status",
  description: "CNIPA legal-status / prosecution timeline lookup (browser)",
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
      description: "ST.16 publication number",
    },
  ],
  columns: ["publication_number", "legal_status", "status_date", "source_url"],
  capabilities: [
    "cdp-browser.navigate",
    "cdp-browser.evaluate",
    "patent.legal-status",
  ],
  minimum_capability: "cdp-browser.evaluate",
  browser: true,
  func: async (page, kwargs) =>
    runCnipaLegalStatus(
      requireBrowserPage(page),
      kwargs as { publication_number: string },
    ),
});
