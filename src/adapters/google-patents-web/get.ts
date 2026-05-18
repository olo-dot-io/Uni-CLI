/**
 * @owner       src::adapters::google-patents-web::get
 * @does        Keyless single-publication detail fetch — parses the SSR meta-tag and `<abstract>` block on https://patents.google.com/patent/<id>/en using regex projection (no DOM, no Chrome).
 * @needs       src/adapters/google-patents-web/_shared.ts, src/engine/normalizer/patent-envelope.ts, src/registry.ts
 * @feeds       src/commands/patent.ts (capability tag patent.get)
 * @breaks      PATENT_NOT_FOUND when the detail page returns 200 but carries no DC.title; PATENT_INVALID_NUMBER for empty input; PATENT_API_DEPRECATED on non-2xx HTTP
 * @invariants  output is a single canonical PatentRecord; abstract whitespace is normalised; HTML entities decoded; source_url is the literal page we hit
 * @side-effects HTTPS egress to patents.google.com only
 * @perf        single page load (~350 KB); regex parse is linear in document length
 * @concurrency safe — stateless
 * @test        verification proof in docs/skills/patent-cookbook.md
 * @stability   experimental
 * @since       2026-05-18
 * @verification keyless-best-effort
 */

import { cli, Strategy } from "../../registry.js";
import { assemblePatentRecord } from "../../engine/normalizer/patent-envelope.js";
import { buildPatentEnvelope } from "../../engine/normalizer/patent-envelope.js";
import {
  GooglePatentsHttpError,
  buildGooglePatentsDetailUrl,
  fetchGooglePatentsHtml,
  stripHtml,
} from "./_shared.js";

const ADAPTER_PATH = "src/adapters/google-patents-web/get.ts";

interface DetailPageFields {
  title?: string;
  abstract?: string;
  inventors: string[];
  assignees: string[];
  filing_date?: string;
  publication_date?: string;
  application_number?: string;
}

function extractMetaContent(html: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(
    `<meta[^>]+name=["']${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*content=["']([^"']*)["']`,
    "gi",
  );
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    if (match[1]) out.push(match[1].trim());
  }
  return out;
}

/**
 * Parse the Google Patents detail HTML into the subset of fields we surface
 * on PatentRecord. The DC.* meta tags are the documented machine-readable
 * surface (Dublin Core), and citation_* mirrors what Google Scholar's
 * indexing crawler consumes.
 */
export function parseGooglePatentsDetail(html: string): DetailPageFields {
  const titleRaw =
    extractMetaContent(html, "DC.title")[0] ??
    extractMetaContent(html, "citation_title")[0];
  const dcDates = extractMetaContent(html, "DC.date");
  const dcContributors = extractMetaContent(html, "DC.contributor");

  // DC.date is emitted twice on Google Patents: filing then publication.
  const filingDate = dcDates[0];
  const publicationDate = dcDates[1];

  // DC.contributor mixes inventors (personal names) and assignees (org
  // names). Google's convention is inventors first, the assignee last —
  // approximate that, with the last-item-is-assignee heuristic.
  const inventors: string[] = [];
  let assignee: string | undefined;
  if (dcContributors.length > 0) {
    assignee = dcContributors[dcContributors.length - 1];
    for (let i = 0; i < dcContributors.length - 1; i++) {
      inventors.push(dcContributors[i]);
    }
  }

  const applicationNumber = extractMetaContent(
    html,
    "citation_patent_application_number",
  )[0];

  // The bibliographic abstract sits in a single `<abstract …>...</abstract>`
  // element. Use a non-greedy match because some pages embed multiple
  // localised abstracts; we want the first.
  let abstractText: string | undefined;
  const abstractMatch = /<abstract\b[^>]*>([\s\S]*?)<\/abstract>/i.exec(html);
  if (abstractMatch) {
    const cleaned = stripHtml(abstractMatch[1]);
    if (cleaned.length > 0) abstractText = cleaned;
  }

  return {
    title: titleRaw ? titleRaw.trim() : undefined,
    abstract: abstractText,
    inventors,
    assignees: assignee ? [assignee] : [],
    filing_date: filingDate,
    publication_date: publicationDate,
    application_number: applicationNumber,
  };
}

export async function runGooglePatentsWebGet(kwargs: {
  publication_number?: unknown;
}): Promise<unknown[]> {
  const raw = String(kwargs.publication_number ?? "").trim();
  if (raw.length === 0) {
    return [
      {
        envelope: buildPatentEnvelope({
          code: "PATENT_INVALID_NUMBER",
          adapter_path: ADAPTER_PATH,
          step: "validate",
          suggestion:
            "google-patents-web get requires a publication_number (e.g. US11741188B2)",
        }),
      },
    ];
  }
  const url = buildGooglePatentsDetailUrl(raw);
  let html: string;
  try {
    html = await fetchGooglePatentsHtml(url);
  } catch (err) {
    if (err instanceof GooglePatentsHttpError) {
      return [
        {
          envelope: buildPatentEnvelope({
            code:
              err.status === 404 ? "PATENT_NOT_FOUND" : "PATENT_API_DEPRECATED",
            adapter_path: ADAPTER_PATH,
            step: "fetch",
            suggestion: `Google Patents detail page returned HTTP ${err.status}; verify the publication number or retry against --sources espacenet`,
            alternatives: ["espacenet", "freepatentsonline-web"],
          }),
        },
      ];
    }
    throw err;
  }
  const detail = parseGooglePatentsDetail(html);
  if (!detail.title) {
    return [
      {
        envelope: buildPatentEnvelope({
          code: "PATENT_NOT_FOUND",
          adapter_path: ADAPTER_PATH,
          step: "select",
          suggestion: `google-patents-web detail page for "${raw}" yielded no DC.title meta tag`,
          alternatives: ["espacenet", "freepatentsonline-web"],
        }),
      },
    ];
  }
  try {
    return [
      assemblePatentRecord({
        publication_number: raw,
        application_number: detail.application_number || undefined,
        title: detail.title,
        abstract: detail.abstract,
        inventors:
          detail.inventors.length > 0
            ? detail.inventors.map((name) => ({ name }))
            : undefined,
        assignees:
          detail.assignees.length > 0
            ? detail.assignees.map((name) => ({ name }))
            : undefined,
        filing_date: detail.filing_date,
        publication_date: detail.publication_date,
        source_adapter: "google-patents-web",
        source_url: url,
      } as Parameters<typeof assemblePatentRecord>[0]),
    ];
  } catch {
    return [
      {
        envelope: buildPatentEnvelope({
          code: "PATENT_NOT_FOUND",
          adapter_path: ADAPTER_PATH,
          step: "normalize",
          suggestion: `google-patents-web detail page for "${raw}" did not yield a canonicalisable publication_number`,
          alternatives: ["espacenet"],
        }),
      },
    ];
  }
}

cli({
  site: "google-patents-web",
  name: "get",
  description:
    "Retrieve a single Google Patents bibliographic record (keyless, no Chrome)",
  domain: "patents.google.com",
  strategy: Strategy.PUBLIC,
  adapter_path: ADAPTER_PATH,
  args: [
    {
      name: "publication_number",
      type: "str",
      required: true,
      positional: true,
      description:
        "ST.16 publication number, compact or segmented (e.g. US11741188B2 or US-11741188-B2)",
    },
  ],
  columns: [
    "publication_number",
    "title",
    "publication_date",
    "assignees",
    "source_url",
  ],
  capabilities: ["http.fetch", "patent.get"],
  minimum_capability: "http.fetch",
  func: async (_page, kwargs) =>
    runGooglePatentsWebGet(kwargs as { publication_number?: unknown }),
});
