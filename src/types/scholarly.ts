/**
 * @owner       src::types::scholarly
 * @does        Defines the normalized scholarly-work record used by first-source academic adapters and the `unicli scholar` meta-command.
 * @needs       none
 * @feeds       src/commands/scholar.ts, src/adapters/{semantic-scholar,crossref,unpaywall,pmlr,cvf,neurips}
 * @breaks      Missing optional fields reduce output richness; missing id/title/source_adapter violates the scholar vertical contract.
 * @invariants  `id` is source-local when DOI is absent; DOI is the preferred dedupe key; dates are ISO-ish strings when present.
 * @side-effects none
 * @perf        O(1) type-only module
 * @concurrency safe
 * @test        tests/unit/commands/scholar.test.ts, tests/unit/adapters/scholar-sources.test.ts
 * @stability   experimental
 * @since       2026-05-19
 */

export interface ScholarlyWorkRecord {
  id: string;
  title: string;
  authors?: string[];
  year?: number;
  date?: string;
  venue?: string;
  type?: string;
  abstract?: string;
  doi?: string;
  arxiv_id?: string;
  pmid?: string;
  openalex_id?: string;
  semantic_scholar_id?: string;
  dblp_key?: string;
  openreview_id?: string;
  cited_by_count?: number;
  references_count?: number;
  is_open_access?: boolean;
  oa_status?: string;
  pdf_url?: string;
  landing_url?: string;
  code_url?: string;
  dataset_url?: string;
  source_adapter: string;
  source_url?: string;
  retrieved_at: string;
  raw?: unknown;
}

export interface ScholarlyReferenceRoute {
  kind:
    | "doi"
    | "arxiv"
    | "pmid"
    | "openalex"
    | "semantic-scholar"
    | "openreview"
    | "dblp"
    | "unknown";
  value: string;
  preferredSources: string[];
}
