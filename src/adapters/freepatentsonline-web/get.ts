/**
 * @owner       src::adapters::freepatentsonline-web::get
 * @does        Keyless single-publication detail fetch from FreePatentsOnline — parses the SSR detail page label/value blocks plus the disp_elm_name_kcode kind-code island so we can canonicalise the publication number even for bare-id US grants where the search-listing URL alone was ambiguous.
 * @needs       src/adapters/freepatentsonline-web/_shared.ts, src/engine/normalizer/patent-envelope.ts, src/registry.ts
 * @feeds       src/commands/patent.ts (capability tag patent.get)
 * @breaks      PATENT_NOT_FOUND when the detail page returns 200 but no Title is parseable; PATENT_INVALID_NUMBER for empty input; PATENT_API_DEPRECATED on non-2xx HTTP
 * @invariants  output is a single canonical PatentRecord whenever both the document-type label and kind code are present; otherwise emit PATENT_SCHEMA_DRIFT rather than canonicalise from an era heuristic
 * @side-effects HTTPS egress to www.freepatentsonline.com only
 * @perf        single page fetch (~130 KB); regex parse linear in document length
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
  FpoHttpError,
  buildFpoDetailUrl,
  fetchFpoHtml,
  parseFpoDetail,
  reconstructCanonicalPubNo,
} from "./_shared.js";

const ADAPTER_PATH = "src/adapters/freepatentsonline-web/get.ts";

interface GetArgs {
  publication_number?: unknown;
}

export async function runFreePatentsOnlineGet(
  kwargs: GetArgs,
): Promise<unknown[]> {
  const raw = String(kwargs.publication_number ?? "").trim();
  if (raw.length === 0) {
    return [
      {
        envelope: buildPatentEnvelope({
          code: "PATENT_INVALID_NUMBER",
          adapter_path: ADAPTER_PATH,
          step: "validate",
          suggestion: "freepatentsonline-web get requires a publication_number",
        }),
      },
    ];
  }
  const url = buildFpoDetailUrl(raw);
  let html: string;
  try {
    html = await fetchFpoHtml(url);
  } catch (err) {
    if (err instanceof FpoHttpError) {
      return [
        {
          envelope: buildPatentEnvelope({
            code:
              err.status === 404 ? "PATENT_NOT_FOUND" : "PATENT_API_DEPRECATED",
            adapter_path: ADAPTER_PATH,
            step: "fetch",
            suggestion: `FreePatentsOnline returned HTTP ${err.status} for ${err.url}`,
            alternatives: ["google-patents-web", "espacenet"],
          }),
        },
      ];
    }
    throw err;
  }
  const detail = parseFpoDetail(html);
  if (!detail.title) {
    return [
      {
        envelope: buildPatentEnvelope({
          code: "PATENT_NOT_FOUND",
          adapter_path: ADAPTER_PATH,
          step: "select",
          suggestion: `freepatentsonline-web detail page for "${raw}" yielded no Title field`,
          alternatives: ["google-patents-web", "espacenet"],
        }),
      },
    ];
  }
  const canonical =
    reconstructCanonicalPubNo(detail.doc_type_label, detail.kind_code) ?? raw;
  try {
    return [
      assemblePatentRecord({
        publication_number: canonical,
        application_number: detail.application_number || undefined,
        title: detail.title,
        abstract: detail.abstract,
        assignees: detail.assignee ? [{ name: detail.assignee }] : undefined,
        filing_date: detail.filing_date,
        publication_date: detail.publication_date,
        source_adapter: "freepatentsonline-web",
        source_url: url,
      } as Parameters<typeof assemblePatentRecord>[0]),
    ];
  } catch {
    return [
      {
        envelope: buildPatentEnvelope({
          code: "PATENT_SCHEMA_DRIFT",
          adapter_path: ADAPTER_PATH,
          step: "normalize",
          suggestion: `freepatentsonline-web detail page for "${raw}" did not yield a canonicalisable publication_number (doc_type=${detail.doc_type_label}; kind_code=${detail.kind_code})`,
          alternatives: ["google-patents-web", "espacenet"],
        }),
      },
    ];
  }
}

cli({
  site: "freepatentsonline-web",
  name: "get",
  description:
    "Retrieve a single FreePatentsOnline bibliographic record (keyless, no Chrome)",
  domain: "www.freepatentsonline.com",
  strategy: Strategy.PUBLIC,
  adapter_path: ADAPTER_PATH,
  args: [
    {
      name: "publication_number",
      type: "str",
      required: true,
      positional: true,
      description:
        "ST.16 publication number, compact or segmented (e.g. US20240220787 or EP3716153A1)",
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
  func: async (_page, kwargs) => runFreePatentsOnlineGet(kwargs as GetArgs),
});
