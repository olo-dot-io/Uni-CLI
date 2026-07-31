/**
 * @owner       src::adapters::espacenet::family
 * @does        Browser-driven Espacenet family lookup — DOCDB simple-family rows visible on the family tab of the detail page; alternative to EPO OPS keyed family broker.
 * @needs       src/adapters/_shared/browser-tools.ts, src/adapters/espacenet/_shared.ts, src/registry.ts
 * @feeds       src/commands/patent.ts (capability tag patent.family)
 * @breaks      PATENT_INVALID_NUMBER, PATENT_NOT_FOUND, PATENT_API_DEPRECATED (browser provider unavailable)
 * @invariants  output rows carry publication_number + jurisdiction + relationship per PatentFamilyMember shape
 * @side-effects controls the registry-owned browser page via CDP
 * @perf        single navigate + evaluate
 * @concurrency safe
 * @test        tests/unit/adapters/espacenet/search.test.ts (transport-error shared path)
 * @stability   experimental
 * @since       2026-05-18
 * @verification browser-only
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { requireBrowserPage } from "../_shared/browser-tools.js";
import { espacenetEnvelope, espacenetNavigateAndExtract } from "./_shared.js";

const ADAPTER_PATH = "src/adapters/espacenet/family.ts";

interface EspacenetFamilyExtract {
  rows: Array<{
    publication_number: string;
    jurisdiction?: string;
    publication_date?: string;
  }>;
}

const FAMILY_EXTRACTOR = `(() => {
  const rows = Array.from(
    document.querySelectorAll('[data-test="family-row"], .familyRow, tr.family-member')
  ).map((el) => {
    const text = (sel) => {
      const node = el.querySelector(sel);
      return node ? (node.textContent || '').trim() : '';
    };
    return {
      publication_number: text('[data-test="publication-number"], .publicationNumber'),
      jurisdiction: text('[data-test="country"], .country'),
      publication_date: text('[data-test="publication-date"], .publicationDate'),
    };
  });
  return { rows };
})()`;

function familyUrlFor(pubNo: string): string {
  return `https://worldwide.espacenet.com/patent/search/family/${encodeURIComponent(pubNo)}`;
}

export async function runEspacenetFamily(
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
          "espacenet family requires a non-empty publication_number",
        ),
      },
    ];
  }
  const url = familyUrlFor(pubNo);
  let extract: EspacenetFamilyExtract;
  const result = await espacenetNavigateAndExtract<EspacenetFamilyExtract>(
    page,
    url,
    FAMILY_EXTRACTOR,
  );
  if (!result.data) {
    return [
      {
        envelope: espacenetEnvelope(
          "PATENT_SCHEMA_DRIFT",
          ADAPTER_PATH,
          "evaluate",
          "espacenet family evaluate returned no data",
        ),
      },
    ];
  }
  extract = result.data;
  if (extract.rows.length === 0) {
    return [
      {
        envelope: espacenetEnvelope(
          "PATENT_NOT_FOUND",
          ADAPTER_PATH,
          "evaluate",
          `espacenet found no family members for "${pubNo}"`,
          ["epo"],
        ),
      },
    ];
  }
  return extract.rows
    .filter((row) => row.publication_number)
    .map((row) => ({
      publication_number: row.publication_number,
      jurisdiction:
        row.jurisdiction || row.publication_number.slice(0, 2).toUpperCase(),
      relationship: "simple_family",
      publication_date: row.publication_date || undefined,
      source_adapter: "espacenet",
    }));
}

cli({
  site: "espacenet",
  name: "family",
  description: "Espacenet DOCDB simple-family lookup (browser)",
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
      description: "ST.16 publication number",
    },
  ],
  columns: [
    "publication_number",
    "jurisdiction",
    "relationship",
    "publication_date",
  ],
  capabilities: [
    "cdp-browser.navigate",
    "cdp-browser.evaluate",
    "patent.family",
  ],
  minimum_capability: "cdp-browser.evaluate",
  browser: true,
  func: async (page, kwargs) =>
    runEspacenetFamily(
      requireBrowserPage(page),
      kwargs as { publication_number: string },
    ),
});
