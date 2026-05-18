/**
 * @owner       src::types::patent
 * @does        Public schema for the patent-search vertical — normalized record shape produced by every patent adapter and consumed by the `unicli patent` meta-command.
 * @needs       none (pure type module)
 * @feeds       src/engine/normalizer/patent-envelope.ts, src/adapters/{uspto,epo,jpo,kipris,inpi-fr,dpma,ipaustralia,lens,google-patents-bq,pqai,patsnap,cnipa,espacenet,cipo,inpi-br,fips}/*, src/commands/patent.ts, src/index.ts (public re-export)
 * @breaks      no runtime — type-only module; downstream callers fail type-check on shape drift
 * @invariants  publication_number conforms to ST.16 (CC + serial + kind); dates are ISO-8601 YYYY-MM-DD; source_adapter equals the adapter site name
 * @side-effects none
 * @perf        n/a
 * @concurrency n/a
 * @test        tests/unit/types/patent.test.ts
 * @stability   stable — public surface; semver-tracked
 * @since       2026-05-18
 */

/**
 * Verification status surfaced in adapter file headers + `unicli patent doctor`.
 *
 *   verified              — adapter exercised against the live endpoint in CI
 *   blocked-by-key        — adapter compiles + lints, but needs an env-var key
 *                           (free-tier registration) before live verification
 *   blocked-by-subscription — adapter compiles, but the upstream API requires
 *                             a paid subscription we do not maintain
 *   waiting-for-api       — upstream announced an API in their roadmap but it
 *                           has not shipped; adapter is a registry placeholder
 *   browser-only          — no upstream API; adapter drives a real browser via
 *                           the MCP browser transport
 */
export type PatentVerificationStatus =
  | "verified"
  | "blocked-by-key"
  | "blocked-by-subscription"
  | "waiting-for-api"
  | "browser-only";

/**
 * Standard 8 commands a patent adapter may expose. Adapters report their
 * supported subset in their `capabilities[]` field; `unicli patent` meta-command
 * routes by capability.
 */
export type PatentCommand =
  | "search"
  | "get"
  | "family"
  | "citations"
  | "legal-status"
  | "fulltext"
  | "pdf"
  | "prior-art";

/**
 * Authorship — a single inventor or applicant entry.
 *
 * `country` is an ISO-3166-1 alpha-2 code when known. `affiliation` is the
 * employer or institution the inventor was associated with at filing time, not
 * the current employer.
 */
export interface PatentParty {
  name: string;
  country?: string;
  affiliation?: string;
}

/**
 * A patent classification code. `scheme` is one of `cpc`, `ipc`, `uspc`, `fi`,
 * `f-term`, `locarno`, or a vendor-specific scheme; `code` is the symbol as the
 * upstream office returns it (no normalization beyond uppercasing).
 */
export interface PatentClassification {
  scheme: string;
  code: string;
  position?: "main" | "further" | "supplemental";
}

/**
 * Cross-jurisdiction sibling. `relationship` matches the DOCDB / INPADOC
 * vocabulary (simple_family | extended_family | continuation | divisional |
 * reissue | reexamination); unknown values are passed through.
 */
export interface PatentFamilyMember {
  publication_number: string;
  jurisdiction: string;
  relationship: string;
}

/**
 * The normalized record shape every patent adapter produces.
 *
 * Required fields are always present; optional fields are present when the
 * upstream API supplies them. Adapters must not synthesize values they cannot
 * verify — leave the field undefined and emit a structured envelope `code` if
 * the gap is unexpected.
 *
 * `raw` preserves the source payload (a slice, when the upstream is verbose)
 * so audit and self-repair flows can inspect the upstream truth.
 */
export interface PatentRecord {
  // Identity
  publication_number: string;
  application_number?: string;
  /**
   * Two-character ST.16 kind code (A1, A2, B1, B2, U1, …) parsed off the
   * publication number. Adapters may set this explicitly; otherwise consumers
   * can derive it via `extractKindCode(publication_number)`.
   */
  kind_code?: string;

  // Bibliographic
  title?: string;
  abstract?: string;
  /**
   * Short matched-context snippet for search results. Distinct from the full
   * abstract: search engines often return a windowed extract around the
   * matched terms; consumers display this in result lists and fetch the full
   * abstract on demand.
   */
  snippet?: string;
  inventors?: PatentParty[];
  assignees?: PatentParty[];
  filing_date?: string;
  publication_date?: string;
  grant_date?: string;
  priority_date?: string;

  // Classification
  classifications?: PatentClassification[];

  // Family / status
  family_id?: string;
  family_members?: PatentFamilyMember[];
  legal_status?: string;

  // Citation graph
  /** Number of claims (independent + dependent) when the upstream exposes it. */
  claims_count?: number;
  /** Forward-citation count — patents that cite this record. */
  cited_by_count?: number;
  /** Backward-citation count — references this record cites. */
  cites_count?: number;

  // Resources
  /** Direct PDF URL when the upstream supplies one (USPTO Image File Wrapper, Lens.org, Patsnap, …). */
  pdf_url?: string;

  // Search-time scoring
  /**
   * Float in [0, 1] populated by semantic / text-rank engines (PQAI,
   * Lens.org `_score`). Absent when the upstream does not rank results.
   */
  relevance_score?: number;

  // Provenance
  source_adapter: string;
  source_url?: string;
  retrieved_at: string;
  raw?: unknown;
}

/**
 * Shape every patent adapter accepts on its `search` command. Adapter-level
 * YAML/TS bodies translate this DSL to the site-specific search syntax (USPTO
 * PatentSearch grammar, EPO CQL, JPO patent-progress query, …).
 *
 * All fields are AND-combined; arrays inside a single field are OR-combined.
 * Adapters return `PATENT_UNSUPPORTED_QUERY` envelope code for fields the
 * upstream cannot express.
 */
export interface PatentSearchQuery {
  text?: string;
  inventors?: string[];
  assignees?: string[];
  cpc?: string[];
  ipc?: string[];
  date_from?: string;
  date_to?: string;
  jurisdictions?: string[];
  limit?: number;
  offset?: number;
}

/**
 * Structured error envelope every patent adapter emits to stderr on failure.
 * Mirrors the Uni-CLI standard envelope shape (`code` / `adapter_path` / …)
 * with a fixed taxonomy of patent-specific failure modes.
 */
export type PatentErrorCode =
  | "PATENT_AUTH_REQUIRED"
  | "PATENT_RATE_LIMIT"
  | "PATENT_NOT_FOUND"
  | "PATENT_INVALID_NUMBER"
  | "PATENT_REGION_BLOCKED"
  | "PATENT_API_DEPRECATED"
  | "PATENT_FAMILY_BROKER_DOWN"
  | "PATENT_BROWSER_CAPTCHA"
  | "PATENT_UNSUPPORTED_QUERY"
  | "PATENT_SCHEMA_DRIFT";

export interface PatentEnvelope {
  code: PatentErrorCode;
  adapter_path: string;
  step: string;
  suggestion: string;
  retryable: boolean;
  alternatives: string[];
  exit_code: number;
}
