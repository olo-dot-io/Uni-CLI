// FIXTURE PROVENANCE: synthetic-shape-only — recorded shape from projectpq.ai/about/api 2026-05-18

/**
 * @owner       tests::unit::integration-fixtures::patent::pqai.fixture
 * @does        Deterministic normalisation test against a fixed PQAI prior-art response fixture; verifies the assembled PatentRecord shape without any network access.
 * @needs       src/engine/normalizer/patent-envelope.ts, fixtures/pqai-prior-art.json
 * @feeds       wave-2 hardening signal — pairs with pqai.live.test.ts
 * @breaks      throws if the fixture file is missing
 * @invariants  PQAI's `patent_id` is compact (US10000001) — the normaliser splits it into ST.16 segments
 * @side-effects file system read
 * @perf        sub-millisecond
 * @concurrency safe
 * @test        self
 * @stability   stable
 * @since       2026-05-18
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { assemblePatentRecord } from "../../../../src/engine/normalizer/patent-envelope.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "fixtures", "pqai-prior-art.json");

interface PqaiFixture {
  results: Array<{
    patent_id: string;
    title?: string;
    abstract?: string;
    score?: number;
  }>;
}

describe("pqai fixture — prior-art normalisation contract", () => {
  it("loads the fixture and asserts the documented response shape", () => {
    const data = JSON.parse(readFileSync(fixturePath, "utf-8")) as PqaiFixture;
    expect(Array.isArray(data.results)).toBe(true);
    expect(data.results.length).toBeGreaterThanOrEqual(2);
    expect(data.results[0].patent_id).toMatch(/^[A-Z]{2}/);
  });

  it("PQAI compact US patent_id without a kind code throws NormalizerError", async () => {
    // PQAI publication ids carry no ST.16 kind code (US10000001 vs the
    // canonical US-10000001-A1). assemblePatentRecord routes through
    // canonicalizePublicationNumber whose regex requires `([A-Z]\d?)` at
    // the end — `1` does not match. The honest behaviour is therefore a
    // throw, not a silent canonicalisation. The PQAI adapter is expected
    // to either (a) append the kind code from upstream's `kind` field
    // when present, or (b) surface PATENT_SCHEMA_DRIFT — never to invent
    // a kind value.
    const { NormalizerError } =
      await import("../../../../src/engine/normalizer/patent-envelope.js");
    expect(() =>
      assemblePatentRecord({
        publication_number: "US10000001",
        source_adapter: "pqai",
      }),
    ).toThrow(NormalizerError);
  });

  it("normalises a PQAI EP record that already carries a kind code", () => {
    const record = assemblePatentRecord({
      publication_number: "EP3500000A1",
      source_adapter: "pqai",
      title: "Optical matrix-multiplier with on-chip modulators",
    });
    expect(record.publication_number).toBe("EP-3500000-A1");
    expect(record.source_adapter).toBe("pqai");
  });
});
