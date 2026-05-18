/**
 * @owner       src::engine::normalizer::patent-envelope
 * @does        Helpers that convert per-site raw responses into the canonical PatentRecord shape; each upstream office is mapped through a dedicated normalizer (uspto / epo / jpo / kipris / inpi-fr / dpma / ipaustralia / lens / google-patents-bq / pqai / patsnap / cnipa / espacenet / cipo / inpi-br / fips).
 * @needs       src/types/patent.ts
 * @feeds       src/adapters/**, src/commands/patent.ts (cross-source fan-out + dedupe), src/engine/steps/map.ts when adapters declare `map: { _normalizer: <site> }`
 * @breaks      throws NormalizerError on missing identity fields (publication_number) — adapters must surface a structured PATENT_SCHEMA_DRIFT envelope rather than yield a half-built PatentRecord
 * @invariants  output is structurally a PatentRecord; dates serialized as ISO-8601; publication_number canonicalized to ST.16 segments (CC-serial-kind) where the upstream allows
 * @side-effects none — pure functions
 * @perf        O(N) over the raw payload size
 * @concurrency safe (pure)
 * @test        tests/unit/engine/normalizer/patent-envelope.test.ts
 * @stability   stable
 * @since       2026-05-18
 */

import type {
  PatentRecord,
  PatentEnvelope,
  PatentErrorCode,
} from "../../types/patent.js";

export class NormalizerError extends Error {
  constructor(
    public readonly source_adapter: string,
    public readonly missing: string[],
    message: string,
  ) {
    super(message);
    this.name = "NormalizerError";
  }
}

/**
 * Canonicalize a publication number to ST.16-style segments separated by `-`.
 * Examples: `US20240123456A1` → `US-20240123456-A1`; `EP4123456A1` → `EP-4123456-A1`.
 * Inputs already in segmented form pass through unchanged.
 */
export function canonicalizePublicationNumber(raw: string): string {
  void raw;
  throw new Error(
    "patent-envelope: canonicalizePublicationNumber not yet implemented (M0 stub — wave-1-subagent-A will fill body)",
  );
}

/**
 * Assemble a PatentRecord from partial site-supplied fields. Throws
 * NormalizerError when `publication_number` or `source_adapter` is absent.
 * Always stamps `retrieved_at` with the current UTC ISO-8601 timestamp.
 */
export function assemblePatentRecord(
  partial: Partial<PatentRecord> & {
    publication_number: string;
    source_adapter: string;
  },
): PatentRecord {
  void partial;
  throw new Error(
    "patent-envelope: assemblePatentRecord not yet implemented (M0 stub — wave-1-subagent-A will fill body)",
  );
}

/**
 * Build a structured error envelope for stderr surfacing. The exit_code is
 * derived from the code class: AUTH=77, RATE_LIMIT=75, NOT_FOUND=66,
 * DEPRECATED=69, default 1.
 */
export function buildPatentEnvelope(input: {
  code: PatentErrorCode;
  adapter_path: string;
  step: string;
  suggestion: string;
  alternatives?: string[];
  retryable?: boolean;
}): PatentEnvelope {
  void input;
  throw new Error(
    "patent-envelope: buildPatentEnvelope not yet implemented (M0 stub — wave-1-subagent-A will fill body)",
  );
}

/**
 * Dedupe a batch of records by family_id; when family_id is missing fall back
 * to canonical publication_number. Preserves first-seen ordering.
 */
export function dedupeByFamily(records: PatentRecord[]): PatentRecord[] {
  void records;
  throw new Error(
    "patent-envelope: dedupeByFamily not yet implemented (M0 stub — wave-1-subagent-A will fill body)",
  );
}
