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

const SEGMENTED_PUBLICATION_RE = /^[A-Z]{2}-[A-Z0-9]+-[A-Z]\d?$/;
const COMPACT_PUBLICATION_RE = /^([A-Z]{2})[-]?([A-Z0-9]+?)[-]?([A-Z]\d?)$/;

/**
 * Canonicalize a publication number to ST.16-style segments separated by `-`.
 * Examples: `US20240123456A1` → `US-20240123456-A1`; `EP4123456A1` → `EP-4123456-A1`.
 * Inputs already in segmented form pass through unchanged.
 */
export function canonicalizePublicationNumber(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new NormalizerError(
      "unknown",
      ["publication_number"],
      "publication_number is empty or not a string",
    );
  }
  const trimmed = raw.trim().toUpperCase();
  if (SEGMENTED_PUBLICATION_RE.test(trimmed)) return trimmed;

  const match = COMPACT_PUBLICATION_RE.exec(trimmed);
  if (!match) {
    throw new NormalizerError(
      "unknown",
      ["publication_number"],
      `cannot parse publication_number "${raw}"; expected ST.16 form (CC + serial + kind)`,
    );
  }
  const [, cc, serial, kind] = match;
  return `${cc}-${serial}-${kind}`;
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
  const missing: string[] = [];
  if (!partial.publication_number) missing.push("publication_number");
  if (!partial.source_adapter) missing.push("source_adapter");
  if (missing.length > 0) {
    throw new NormalizerError(
      partial.source_adapter ?? "unknown",
      missing,
      `assemblePatentRecord missing required field(s): ${missing.join(", ")}`,
    );
  }
  return {
    ...partial,
    publication_number: canonicalizePublicationNumber(
      partial.publication_number,
    ),
    source_adapter: partial.source_adapter,
    retrieved_at: new Date().toISOString(),
  };
}

const EXIT_CODE_BY_CLASS: Record<PatentErrorCode, number> = {
  PATENT_AUTH_REQUIRED: 77,
  PATENT_RATE_LIMIT: 75,
  PATENT_NOT_FOUND: 66,
  PATENT_API_DEPRECATED: 69,
  PATENT_REGION_BLOCKED: 77,
  PATENT_INVALID_NUMBER: 65,
  PATENT_FAMILY_BROKER_DOWN: 1,
  PATENT_BROWSER_CAPTCHA: 1,
  PATENT_UNSUPPORTED_QUERY: 1,
  PATENT_SCHEMA_DRIFT: 1,
};

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
  return {
    code: input.code,
    adapter_path: input.adapter_path,
    step: input.step,
    suggestion: input.suggestion,
    retryable: input.retryable ?? false,
    alternatives: input.alternatives ?? [],
    exit_code: EXIT_CODE_BY_CLASS[input.code] ?? 1,
  };
}

/**
 * Dedupe a batch of records by family_id; when family_id is missing fall back
 * to canonical publication_number. Preserves first-seen ordering.
 */
export function dedupeByFamily(records: PatentRecord[]): PatentRecord[] {
  const seen = new Set<string>();
  const out: PatentRecord[] = [];
  for (const record of records) {
    const key =
      record.family_id ??
      canonicalizePublicationNumber(record.publication_number);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
}
