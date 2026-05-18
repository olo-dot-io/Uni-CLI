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

  it("fixture XML carries the documented DOCDB paths the adapter map extracts", () => {
    // FIELD CROSS-REFERENCE: each path below maps to a documented OPS v3.2
    // DOCDB element (docs.epo.org). The adapter map step's JSON-stringify
    // extractor walks these paths; this assertion is the contract that the
    // fixture exercises every one.
    const xml = readFileSync(fixturePath, "utf-8");
    // FIELD: parties.inventors.inventor[].inventor-name.name
    expect(xml).toContain("<inventor-name>");
    expect(xml).toContain("SMITH, JOHN");
    expect(xml).toContain("JONES, JANE");
    // FIELD: parties.applicants.applicant[].applicant-name.name
    expect(xml).toContain("<applicant-name>");
    expect(xml).toContain("QUANTUM RESEARCH GMBH");
    // FIELD: classifications-ipcr.classification-ipcr[].text (IPC)
    expect(xml).toContain("<classifications-ipcr>");
    expect(xml).toMatch(/G06N\s+10\/00/);
    // FIELD: patent-classifications.patent-classification[] (CPC tree)
    expect(xml).toContain("<patent-classifications>");
    expect(xml).toContain("<main-group>10</main-group>");
    // FIELD: priority-claims.priority-claim[].document-id.date
    expect(xml).toContain("<priority-claims>");
    expect(xml).toContain("<date>20210930</date>");
    // FIELD: abstract.p — EN
    expect(xml).toContain('lang="en"');
    expect(xml).toContain("plurality of qubits");
    // FIELD: @family-id on the exchange-document element
    expect(xml).toContain('family-id="68000000"');
  });

  it("normaliser preserves the enriched EPO field set on assembly", () => {
    // Map the documented DOCDB fields into a PatentRecord and confirm the
    // normaliser passes them through unchanged. (The XML-walking step is
    // exercised at the adapter-pipeline level; the type contract here is
    // what callers consume.)
    const record = assemblePatentRecord({
      publication_number: "EP-4123456-A1",
      source_adapter: "epo",
      title: "Quantum computing apparatus",
      abstract:
        "A quantum computing apparatus comprising a plurality of qubits and a coupling structure.",
      application_number: "EP-22123456-A",
      kind_code: "A1",
      family_id: "68000000",
      filing_date: "2022-10-01",
      publication_date: "2024-04-18",
      priority_date: "2021-09-30",
      inventors: [{ name: "SMITH, JOHN" }, { name: "JONES, JANE" }],
      assignees: [{ name: "QUANTUM RESEARCH GMBH" }],
      classifications: [
        { scheme: "ipc", code: "G06N  10/00" },
        { scheme: "cpc", code: "G06N10/00" },
      ],
    });
    expect(record.abstract).toMatch(/qubits/);
    expect(record.kind_code).toBe("A1");
    expect(record.family_id).toBe("68000000");
    expect(record.priority_date).toBe("2021-09-30");
    expect(record.inventors).toHaveLength(2);
    expect(record.assignees?.[0].name).toBe("QUANTUM RESEARCH GMBH");
    expect(record.classifications).toHaveLength(2);
  });
});
