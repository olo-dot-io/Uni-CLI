/**
 * @owner       src::types::scholarly
 * @does        Defines the normalized scholarly-work record used by first-source academic adapters and the `unicli scholar` meta-command, including paper artifact, search provenance, and resource links.
 * @needs       none
 * @feeds       src/commands/scholar.ts, first-source scholarly adapters, PDF/fulltext discovery rows, code/dataset/model resource rows
 * @breaks      Missing optional fields reduce output richness; missing id/title/source_adapter violates the scholar vertical contract; missing provenance/fulltext/resource identity fields prevents bounded-search disclosure, source-direct reading, and resource discovery.
 * @invariants  `id` is source-local when DOI is absent; DOI is the preferred dedupe key; dates are ISO-ish strings when present; search provenance fields describe adapter scope rather than paper facts.
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
  publication_year?: number;
  conference_year?: number;
  date?: string;
  venue?: string;
  volume?: string;
  issue?: string;
  type?: string;
  abstract?: string;
  doi?: string;
  arxiv_id?: string;
  pmid?: string;
  pmc_id?: string;
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
  project_url?: string;
  relationship?: string;
  is_official_code?: boolean;
  verification?: string;
  match_type?: string;
  confidence?: number;
  evidence_url?: string;
  evidence_excerpt?: string;
  relationship_evidence?: string[];
  dataset_url?: string;
  model_urls?: string;
  dataset_urls?: string;
  space_urls?: string;
  github_stars?: number;
  num_models?: number;
  num_datasets?: number;
  num_spaces?: number;
  source_adapter: string;
  source_url?: string;
  matched_fields?: string[];
  search_scope?: string;
  search_window?: string;
  search_scanned_records?: number;
  search_total_records?: number;
  search_exhaustive?: boolean;
  search_query?: string;
  query_corrections?: string[];
  retrieved_at: string;
  raw?: unknown;
}

/**
 * A source-backed relationship around a scholarly work or venue.
 *
 * Context records keep official awards, conference-program entries, review
 * threads, announcements, and artifacts separate from bibliographic work
 * metadata while retaining the identifiers needed to join them.
 */
export interface ScholarlyContextRecord {
  id: string;
  title: string;
  relation:
    | "official-conference"
    | "official-program"
    | "official-award"
    | "peer-review-thread"
    | "publisher-record"
    | "pdf"
    | "code"
    | "dataset"
    | string;
  authors?: string[];
  year?: number;
  venue?: string;
  type?: string;
  abstract?: string;
  doi?: string;
  openreview_id?: string;
  award?: string;
  pdf_url?: string;
  landing_url?: string;
  source_adapter: string;
  source_url?: string;
  next_command?: string;
  source_errors?: string[];
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
