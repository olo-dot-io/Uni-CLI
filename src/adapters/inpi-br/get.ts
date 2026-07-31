/**
 * @owner       src::adapters::inpi-br::get
 * @does        Browser-driven retrieval of an INPI Brasil patent record by application/publication number; extracts the bibliographic block from the pePI detail page.
 * @needs       src/adapters/_shared/browser-tools.ts, src/engine/normalizer/patent-envelope.ts, src/adapters/inpi-br/_shared.ts, src/registry.ts
 * @feeds       src/commands/patent.ts (capability tag patent.get)
 * @breaks      PATENT_INVALID_NUMBER, PATENT_NOT_FOUND, PATENT_API_DEPRECATED (browser provider unavailable)
 * @invariants  output row is a canonical PatentRecord
 * @side-effects controls the registry-owned browser page via CDP
 * @perf        single navigate + evaluate
 * @concurrency safe
 * @test        tests/unit/adapters/inpi-br/search.test.ts (shared transport-error path)
 * @stability   experimental
 * @since       2026-05-18
 * @verification browser-only
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { requireBrowserPage } from "../_shared/browser-tools.js";
import { assemblePatentRecord } from "../../engine/normalizer/patent-envelope.js";
import { inpiBrEnvelope, inpiBrNavigateAndExtract } from "./_shared.js";

const ADAPTER_PATH = "src/adapters/inpi-br/get.ts";

interface InpiBrDetail {
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
    publication_number: text('[data-field="numPedido"], .num-pedido, td.numero'),
    application_number: text('[data-field="numAplicacao"], .num-aplicacao'),
    title: text('[data-field="titulo"], .titulo, h1'),
    abstract: text('[data-field="resumo"], .resumo'),
    applicant: text('[data-field="depositante"], .depositante'),
    inventor: text('[data-field="inventor"], .inventor'),
    publication_date: text('[data-field="dataPub"], .data-pub'),
    filing_date: text('[data-field="dataDep"], .data-dep'),
    source_url: location.href,
  };
})()`;

function detailUrlFor(pubNo: string): string {
  const stripped = pubNo.replace(/^BR[-]?/, "");
  const params = new URLSearchParams({
    Action: "detail",
    NumPedido: stripped,
  });
  return `https://busca.inpi.gov.br/pePI/servlet/PatenteServletController?${params.toString()}`;
}

export async function runInpiBrGet(
  page: IPage,
  kwargs: {
    publication_number: string;
  },
): Promise<unknown[]> {
  const pubNo = String(kwargs.publication_number ?? "").trim();
  if (pubNo.length === 0) {
    return [
      {
        envelope: inpiBrEnvelope(
          "PATENT_INVALID_NUMBER",
          ADAPTER_PATH,
          "validate",
          "inpi-br get requires a non-empty publication_number",
        ),
      },
    ];
  }
  const url = detailUrlFor(pubNo);
  let detail: InpiBrDetail;
  const result = await inpiBrNavigateAndExtract<InpiBrDetail>(
    page,
    url,
    DETAIL_EXTRACTOR,
  );
  if (!result.data) {
    return [
      {
        envelope: inpiBrEnvelope(
          "PATENT_SCHEMA_DRIFT",
          ADAPTER_PATH,
          "evaluate",
          "inpi-br detail evaluate returned no data",
        ),
      },
    ];
  }
  detail = result.data;
  if (!detail.publication_number && !detail.title) {
    return [
      {
        envelope: inpiBrEnvelope(
          "PATENT_NOT_FOUND",
          ADAPTER_PATH,
          "evaluate",
          `inpi-br detail page for "${pubNo}" yielded no bibliographic fields`,
          ["espacenet"],
        ),
      },
    ];
  }
  const rawPubNo = detail.publication_number || pubNo;
  const canonicalPubNo = /^BR[-]?/.test(rawPubNo) ? rawPubNo : `BR${rawPubNo}`;
  try {
    return [
      assemblePatentRecord({
        publication_number: canonicalPubNo,
        application_number: detail.application_number || undefined,
        title: detail.title || undefined,
        abstract: detail.abstract || undefined,
        assignees: detail.applicant
          ? [{ name: detail.applicant, country: "BR" }]
          : undefined,
        inventors: detail.inventor
          ? [{ name: detail.inventor, country: "BR" }]
          : undefined,
        publication_date: detail.publication_date || undefined,
        filing_date: detail.filing_date || undefined,
        source_adapter: "inpi-br",
        source_url: detail.source_url || url,
      } as Parameters<typeof assemblePatentRecord>[0]),
    ];
  } catch {
    return [
      {
        envelope: inpiBrEnvelope(
          "PATENT_NOT_FOUND",
          ADAPTER_PATH,
          "normalize",
          `inpi-br detail page for "${pubNo}" did not yield a valid publication_number`,
          ["espacenet"],
        ),
      },
    ];
  }
}

cli({
  site: "inpi-br",
  name: "get",
  description: "Retrieve a single INPI Brasil patent record (browser-only)",
  domain: "busca.inpi.gov.br",
  strategy: Strategy.PUBLIC,
  adapter_path: ADAPTER_PATH,
  args: [
    {
      name: "publication_number",
      type: "str",
      minLength: 1,
      pattern: "^(?:BR-?)?[A-Z0-9]+-?[A-Z][0-9]?$",
      required: true,
      positional: true,
      description: "Brazil patent application/publication number",
    },
  ],
  columns: [
    "publication_number",
    "title",
    "publication_date",
    "filing_date",
    "source_url",
  ],
  capabilities: ["cdp-browser.navigate", "cdp-browser.evaluate", "patent.get"],
  minimum_capability: "cdp-browser.evaluate",
  browser: true,
  func: async (page, kwargs) =>
    runInpiBrGet(
      requireBrowserPage(page),
      kwargs as { publication_number: string },
    ),
});
