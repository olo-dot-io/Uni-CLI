/**
 * @owner       tests::unit::types::patent
 * @does        Compile-time + runtime checks on the optional `PatentRecord`
 *              fields added in the wave-2 enrichment work. Confirms each new
 *              field is optional (the minimal-required constructor still
 *              type-checks), typed correctly, and observable on a constructed
 *              record.
 * @needs       src/types/patent.ts, src/engine/normalizer/patent-envelope.ts
 * @feeds       wave-2 hardening signal; pairs with the adapter map enrichments
 * @breaks      none — pure type + value assertions
 * @invariants  every assertion below is a contract that downstream callers
 *              depend on; renaming a field requires updating this file and
 *              the public-surface test in lockstep
 * @side-effects none
 * @perf        sub-millisecond
 * @concurrency safe
 * @test        self
 * @stability   stable
 * @since       2026-05-18
 */

import { describe, expect, it } from "vitest";

import type { PatentRecord } from "../../../src/types/patent.js";
import { extractKindCode } from "../../../src/engine/normalizer/patent-envelope.js";

describe("PatentRecord — optional field surface", () => {
  it("constructs with only required fields (publication_number + source_adapter + retrieved_at)", () => {
    // The minimal-shape contract: every new optional field must NOT become
    // load-bearing. A bare record still type-checks and round-trips.
    const minimal: PatentRecord = {
      publication_number: "US-20240123456-A1",
      source_adapter: "uspto",
      retrieved_at: "2026-05-18T00:00:00.000Z",
    };
    expect(minimal.publication_number).toBe("US-20240123456-A1");
    expect(minimal.kind_code).toBeUndefined();
    expect(minimal.snippet).toBeUndefined();
    expect(minimal.claims_count).toBeUndefined();
    expect(minimal.cited_by_count).toBeUndefined();
    expect(minimal.cites_count).toBeUndefined();
    expect(minimal.pdf_url).toBeUndefined();
    expect(minimal.relevance_score).toBeUndefined();
  });

  it("accepts kind_code as a two-character ST.16 string", () => {
    const record: PatentRecord = {
      publication_number: "US-20240123456-A1",
      source_adapter: "uspto",
      retrieved_at: "2026-05-18T00:00:00.000Z",
      kind_code: "A1",
    };
    expect(record.kind_code).toBe("A1");
  });

  it("accepts snippet as a short matched-context string distinct from abstract", () => {
    const record: PatentRecord = {
      publication_number: "US-20240123456-A1",
      source_adapter: "lens",
      retrieved_at: "2026-05-18T00:00:00.000Z",
      abstract: "A full-length abstract …",
      snippet: "…matched-context window with <em>highlighted</em> terms…",
    };
    expect(record.abstract).not.toBe(record.snippet);
  });

  it("accepts citation counts as plain numbers (no string fallback)", () => {
    const record: PatentRecord = {
      publication_number: "US-20240123456-A1",
      source_adapter: "lens",
      retrieved_at: "2026-05-18T00:00:00.000Z",
      claims_count: 20,
      cited_by_count: 137,
      cites_count: 42,
    };
    expect(typeof record.claims_count).toBe("number");
    expect(record.cited_by_count).toBe(137);
    expect(record.cites_count).toBe(42);
  });

  it("accepts pdf_url as an https URL string", () => {
    const record: PatentRecord = {
      publication_number: "US-20240123456-A1",
      source_adapter: "lens",
      retrieved_at: "2026-05-18T00:00:00.000Z",
      pdf_url:
        "https://patentimages.storage.googleapis.com/00/01/US20240123456A1.pdf",
    };
    expect(record.pdf_url?.startsWith("https://")).toBe(true);
  });

  it("accepts relevance_score as a float in [0, 1] (range enforced by adapter)", () => {
    const record: PatentRecord = {
      publication_number: "EP-3500000-A1",
      source_adapter: "pqai",
      retrieved_at: "2026-05-18T00:00:00.000Z",
      relevance_score: 0.873,
    };
    expect(record.relevance_score).toBeGreaterThanOrEqual(0);
    expect(record.relevance_score).toBeLessThanOrEqual(1);
  });

  it("permits all new optional fields on a single record simultaneously", () => {
    const record: PatentRecord = {
      publication_number: "US-20240123456-A1",
      source_adapter: "lens",
      retrieved_at: "2026-05-18T00:00:00.000Z",
      kind_code: "A1",
      snippet: "…matched-context…",
      claims_count: 20,
      cited_by_count: 137,
      cites_count: 42,
      pdf_url: "https://example.test/p.pdf",
      relevance_score: 0.9,
    };
    expect(Object.keys(record).sort()).toEqual(
      [
        "publication_number",
        "source_adapter",
        "retrieved_at",
        "kind_code",
        "snippet",
        "claims_count",
        "cited_by_count",
        "cites_count",
        "pdf_url",
        "relevance_score",
      ].sort(),
    );
  });
});

describe("extractKindCode — derive ST.16 kind suffix", () => {
  it("returns the kind code from a segmented publication number", () => {
    expect(extractKindCode("US-20240123456-A1")).toBe("A1");
    expect(extractKindCode("EP-4123456-A1")).toBe("A1");
    expect(extractKindCode("US-1234567-B2")).toBe("B2");
  });

  it("returns the kind code from a compact publication number", () => {
    expect(extractKindCode("US20240123456A1")).toBe("A1");
    expect(extractKindCode("EP4123456A1")).toBe("A1");
  });

  it("normalises lowercase input", () => {
    expect(extractKindCode("us-20240123456-a1")).toBe("A1");
  });

  it("returns undefined for unparseable input rather than inventing a kind", () => {
    // Honesty contract: this helper never synthesises a kind code from
    // nothing. A publication number that does not carry a kind segment is
    // a legitimate gap, surfaced as undefined.
    expect(extractKindCode("")).toBeUndefined();
    expect(extractKindCode("US10000001")).toBeUndefined();
    expect(extractKindCode("???")).toBeUndefined();
  });
});
