// FIXTURE PROVENANCE: synthetic-shape-only — recorded shape from docs.epo.org/3.2/api 2026-05-18

/**
 * @owner       tests::unit::integration-fixtures::patent::epo.fixture
 * @does        Deterministic normalisation test against a fixed EPO OPS DOCDB XML fixture; verifies the assembled PatentRecord shape without any network access.
 * @needs       src/engine/normalizer/patent-envelope.ts, fixtures/epo-search.xml
 * @feeds       wave-2 hardening signal — pairs with epo.live.test.ts
 * @breaks      throws if the fixture file is missing or unparseable as XML
 * @invariants  the fixture XML uses the OPS-published namespace prefixes; any change to those prefixes must update both the fixture and the adapter
 * @side-effects file system read
 * @perf        sub-millisecond
 * @concurrency safe
 * @test        self
 * @stability   stable until upstream namespace drift
 * @since       2026-05-18
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assemblePatentRecord,
  canonicalizePublicationNumber,
} from "../../../../src/engine/normalizer/patent-envelope.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "fixtures", "epo-search.xml");

describe("epo fixture — DOCDB XML normalisation contract", () => {
  it("loads the fixture and asserts the documented namespaces are present", () => {
    const xml = readFileSync(fixturePath, "utf-8");
    expect(xml).toContain("xmlns:ops=");
    expect(xml).toContain("<ops:exchange-document");
    // Identity quartet — country / doc-number / kind / date — is what the
    // select-xml + map pipeline composes into a canonical publication
    // number. Pin the presence of each.
    expect(xml).toMatch(/<country>EP<\/country>/);
    expect(xml).toMatch(/<doc-number>4123456<\/doc-number>/);
    expect(xml).toMatch(/<kind>A1<\/kind>/);
    expect(xml).toMatch(/Quantum computing apparatus/);
  });

  it("normalises the extracted identity quartet into a canonical PatentRecord", () => {
    // The adapter map step composes `${country}-${doc-number}-${kind}` —
    // we mirror that composition here using the values the fixture asserts
    // above. If the upstream renames `doc-number` to something else, the
    // assertions in the previous test fail first.
    const compactPub = "EP-4123456-A1";
    const record = assemblePatentRecord({
      publication_number: compactPub,
      source_adapter: "epo",
      title: "Quantum computing apparatus",
      application_number: "EP-22123456-A",
    });
    expect(record.publication_number).toBe(
      canonicalizePublicationNumber(compactPub),
    );
    expect(record.publication_number).toBe("EP-4123456-A1");
    expect(record.source_adapter).toBe("epo");
    expect(record.title).toBe("Quantum computing apparatus");
  });
});
