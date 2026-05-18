// FIXTURE PROVENANCE: synthetic-shape-only — recorded shape from data.uspto.gov/swagger 2026-05-18

/**
 * @owner       tests::unit::integration-fixtures::patent::uspto.fixture
 * @does        Deterministic normalisation test against a fixed USPTO ODP response fixture; verifies the assembled PatentRecord shape without any network access.
 * @needs       src/engine/normalizer/patent-envelope.ts, fixtures/uspto-search.json
 * @feeds       wave-2 hardening signal — pairs with uspto.live.test.ts (gated on USPTO_ODP_API_KEY)
 * @breaks      reads the fixture from disk; throws if the file is missing — the test is the contract
 * @invariants  fixture file is treated as immutable; any schema drift surfaces as a diff in this test, not silently
 * @side-effects file system read of the sibling fixtures/ directory
 * @perf        sub-millisecond
 * @concurrency safe
 * @test        self
 * @stability   stable until upstream schema drift retires the fixture
 * @since       2026-05-18
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  NormalizerError,
  assemblePatentRecord,
  canonicalizePublicationNumber,
} from "../../../../src/engine/normalizer/patent-envelope.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "fixtures", "uspto-search.json");

interface UsptoFixture {
  count: number;
  patentFileWrapperDataBag: Array<{
    applicationNumberText?: string;
    applicationMetaData?: {
      earliestPublicationNumber?: string;
      inventionTitle?: string;
      filingDate?: string;
      earliestPublicationDate?: string;
      grantDate?: string | null;
    };
  }>;
}

describe("uspto fixture — adapter normalisation contract", () => {
  it("loads the fixture and asserts the documented response shape", () => {
    const raw = readFileSync(fixturePath, "utf-8");
    const data = JSON.parse(raw) as UsptoFixture;
    expect(Array.isArray(data.patentFileWrapperDataBag)).toBe(true);
    expect(data.patentFileWrapperDataBag.length).toBe(1);
  });

  it("normalises the fixture row into a PatentRecord with canonical publication_number", () => {
    const raw = readFileSync(fixturePath, "utf-8");
    const data = JSON.parse(raw) as UsptoFixture;
    const row = data.patentFileWrapperDataBag[0];
    const meta = row.applicationMetaData!;
    const compactPub = `US-${meta.earliestPublicationNumber!}`;
    const record = assemblePatentRecord({
      publication_number: compactPub,
      application_number: row.applicationNumberText,
      source_adapter: "uspto",
      title: meta.inventionTitle,
      filing_date: meta.filingDate,
      publication_date: meta.earliestPublicationDate,
    });
    expect(record.publication_number).toBe(
      canonicalizePublicationNumber(compactPub),
    );
    expect(record.publication_number).toBe("US-20240123456-A1");
    expect(record.source_adapter).toBe("uspto");
    expect(record.application_number).toBe("17/123456");
    expect(record.title).toBe("Optical computing apparatus and methods");
    expect(record.filing_date).toBe("2023-06-15");
    expect(Date.parse(record.retrieved_at)).toBeGreaterThan(0);
  });

  it("surfaces NormalizerError when the publication-number field is empty", () => {
    expect(() =>
      assemblePatentRecord({
        publication_number: "",
        source_adapter: "uspto",
      }),
    ).toThrow(NormalizerError);
  });
});
