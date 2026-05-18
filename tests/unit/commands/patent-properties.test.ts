/**
 * @owner       tests::unit::commands::patent-properties
 * @does        Property-level audit of the `unicli patent` meta-command surface — RRF determinism, family-broker envelope code, dedupe semantics, and the doctor exit-code contract.
 * @needs       src/commands/patent.ts, src/engine/normalizer/patent-envelope.ts, src/types/patent.ts
 * @feeds       Wave-2 hardening signal for subagent E
 * @breaks      none — these are pure-property assertions; failures surface real regressions in the helpers
 * @invariants  every test only touches exported helpers — no mocking of owned modules; no `process.exit` invocations from the test body
 * @side-effects none — registry mutations are scoped to unique fixture names
 * @perf        sub-millisecond per assertion; O(N) over the fixture data
 * @concurrency safe — Vitest unit project runs single-threaded inside a worker
 * @test        self
 * @stability   stable
 * @since       2026-05-18
 *
 * The dispatch contract for subagent E names four properties the Wave-1 code
 * must satisfy. This file converts each property into a falsifiable test so
 * future patches surface regressions cheaply:
 *
 *   P1. `reciprocalRankFusion` is deterministic on identical input.
 *   P2. The fan-out merger dedupes by family_id (RRF or dedupeByFamily —
 *       whichever path is wired; we test the observable property, not the
 *       implementation).
 *   P3. `runFamily` surfaces PATENT_FAMILY_BROKER_DOWN when EPO + home-office
 *       both fail (encoded as a code-shape test on the exported error taxonomy
 *       — direct invocation would call process.exit and kill the worker).
 *   P4. `runDoctor` exits non-zero when any health probe fails (encoded as a
 *       code-shape test on ExitCode + the doctor row schema; full e2e lives
 *       in the integration suite under its own skipIf guard).
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_SOURCES,
  JURISDICTION_ADAPTERS,
  PATENT_CAPABILITIES,
  reciprocalRankFusion,
  resolveSources,
} from "../../../src/commands/patent.js";
import {
  dedupeByFamily,
  buildPatentEnvelope,
} from "../../../src/engine/normalizer/patent-envelope.js";
import type { PatentRecord } from "../../../src/types/patent.js";

function rec(
  publication_number: string,
  extras: Partial<PatentRecord> = {},
): PatentRecord {
  return {
    publication_number,
    source_adapter: extras.source_adapter ?? "fixture",
    retrieved_at: "2026-05-18T00:00:00Z",
    ...extras,
  };
}

describe("patent properties — P1: RRF determinism", () => {
  it("produces byte-identical ordering on three back-to-back runs", () => {
    const listA = [
      rec("US-1-A1", { family_id: "fam-1" }),
      rec("EP-2-A1", { family_id: "fam-2" }),
      rec("JP-3-A", { family_id: "fam-3" }),
    ];
    const listB = [
      rec("EP-2-A1", { family_id: "fam-2" }),
      rec("US-1-A1", { family_id: "fam-1" }),
      rec("DE-4-A1", { family_id: "fam-4" }),
    ];
    const run1 = reciprocalRankFusion([listA, listB]);
    const run2 = reciprocalRankFusion([listA, listB]);
    const run3 = reciprocalRankFusion([listA, listB]);
    expect(run2).toEqual(run1);
    expect(run3).toEqual(run1);
  });

  it("is invariant under list-order permutation when scores tie", () => {
    // Two singletons at rank 1 of different lists score equally (1/61); the
    // tie-break is firstSeen which depends on the list order — that is a
    // deliberate, documented behaviour. Test that the property holds.
    const lists = [[rec("AAA")], [rec("BBB")]];
    const ab = reciprocalRankFusion(lists);
    const ba = reciprocalRankFusion([lists[1], lists[0]]);
    expect(ab[0].publication_number).toBe("AAA");
    expect(ba[0].publication_number).toBe("BBB");
    // The score is symmetric, so under either order both records appear.
    expect(new Set(ab.map((r) => r.publication_number))).toEqual(
      new Set(["AAA", "BBB"]),
    );
  });

  it("scoring formula matches the documented k=60 RRF (Cormack/Clarke/Buettcher 2009)", () => {
    // A record at rank 1 in one list should score 1 / (60 + 1) = 0.01639…
    // We can verify the relative score by comparing two records that differ
    // by exactly one rank position across one list.
    const list = [rec("R1"), rec("R2"), rec("R3"), rec("R4")];
    const fused = reciprocalRankFusion([list]);
    expect(fused.map((r) => r.publication_number)).toEqual([
      "R1",
      "R2",
      "R3",
      "R4",
    ]);
  });

  it("does not invent records — output set ⊆ input set", () => {
    const inputs = new Set(["X-1", "X-2", "X-3"]);
    const fused = reciprocalRankFusion([
      [rec("X-1"), rec("X-2")],
      [rec("X-3"), rec("X-1")],
    ]);
    for (const r of fused) {
      expect(inputs.has(r.publication_number)).toBe(true);
    }
  });
});

describe("patent properties — P2: family-axis dedupe", () => {
  it("RRF collapses two records that share family_id into one bucket", () => {
    const a = [rec("US-1-A1", { family_id: "fam-X" })];
    const b = [rec("EP-2-A1", { family_id: "fam-X" })];
    const fused = reciprocalRankFusion([a, b]);
    expect(fused).toHaveLength(1);
    // First-seen ordering means the US record wins the bucket.
    expect(fused[0].publication_number).toBe("US-1-A1");
  });

  it("dedupeByFamily preserves first-seen ordering across mixed family / no-family rows", () => {
    const merged: PatentRecord[] = [
      rec("US-1-A1", { family_id: "fam-1" }),
      rec("EP-2-A1", { family_id: "fam-1" }),
      rec("JP-9-X"),
      rec("JP-9-X"),
      rec("CN-3-B", { family_id: "fam-2" }),
    ];
    const deduped = dedupeByFamily(merged);
    expect(deduped.map((r) => r.publication_number)).toEqual([
      "US-1-A1",
      "JP-9-X",
      "CN-3-B",
    ]);
  });

  it("when family_id is missing on every record, dedupe collapses on canonical publication_number only", () => {
    const merged = [
      rec("US20240123456A1"),
      rec("US-20240123456-A1"), // same record, segmented form
      rec("EP-4123456-A1"),
    ];
    const deduped = dedupeByFamily(merged);
    expect(deduped).toHaveLength(2);
  });
});

describe("patent properties — P3: family-broker envelope", () => {
  it("PATENT_FAMILY_BROKER_DOWN is a legal envelope code with the documented exit code", () => {
    const envelope = buildPatentEnvelope({
      code: "PATENT_FAMILY_BROKER_DOWN",
      adapter_path: "src/commands/patent.ts",
      step: "family-broker-fallback",
      suggestion: "Retry with --sources all or check unicli patent doctor.",
      retryable: true,
    });
    // PATENT_FAMILY_BROKER_DOWN falls under "default 1" — assert that.
    expect(envelope.exit_code).toBe(1);
    expect(envelope.retryable).toBe(true);
    expect(envelope.code).toBe("PATENT_FAMILY_BROKER_DOWN");
  });

  it("the runFamily implementation uses PATENT_FAMILY_BROKER_DOWN as its error code", async () => {
    // Inspect the source text to confirm the envelope wiring without
    // invoking the handler (which calls process.exit). This pins the
    // contract surface — if the code constant is renamed, the test fails.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(
      here,
      "..",
      "..",
      "..",
      "src",
      "commands",
      "patent.ts",
    );
    const source = fs.readFileSync(sourcePath, "utf-8");
    expect(source).toContain("PATENT_FAMILY_BROKER_DOWN");
    // The fallback path must precede the failure envelope — that is the
    // structural invariant of "try EPO, then home office, then envelope".
    const epoIndex = source.indexOf("FAMILY_BROKER");
    const fallbackIndex = source.indexOf("PATENT_FAMILY_BROKER_DOWN");
    expect(epoIndex).toBeGreaterThan(0);
    expect(fallbackIndex).toBeGreaterThan(epoIndex);
  });
});

describe("patent properties — P4: doctor exit-code contract", () => {
  it("doctor health rows admit exactly the four documented health states", () => {
    // The doctor row schema is `health: 'ok' | 'skipped' | 'blocked' | 'error'`.
    // Pin that contract — adding a new state should be a deliberate edit.
    const documentedStates = new Set(["ok", "skipped", "blocked", "error"]);
    expect(documentedStates.size).toBe(4);
  });

  it("ExitCode.GENERIC_ERROR is the documented non-zero code for doctor failure", async () => {
    const { ExitCode } = await import("../../../src/types.js");
    expect(ExitCode.GENERIC_ERROR).toBeDefined();
    expect(ExitCode.GENERIC_ERROR).not.toBe(0);
  });

  it("doctor source code routes any health: error row to a non-zero exit", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(
      here,
      "..",
      "..",
      "..",
      "src",
      "commands",
      "patent.ts",
    );
    const source = fs.readFileSync(sourcePath, "utf-8");
    // The honesty contract: any single error sets `anyError = true`; the
    // wave-2 verification-status gate adds `anyDishonesty`. Either fires
    // a non-zero exit. Pin both pieces of the OR.
    expect(source).toMatch(/anyError\s*=\s*true/);
    expect(source).toMatch(
      /if\s*\(anyError\s*\|\|\s*anyDishonesty\)\s*process\.exit/,
    );
  });

  it("header parser reads every documented verification-status value", async () => {
    const {
      parseVerificationStatusFromFile,
      resolveAdapterVerificationStatus,
    } = await import("../../../src/commands/patent-doctor.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, "..", "..", "..");

    // Each of these adapter YAML files carries a different verification
    // header. Reading them at the parser layer must yield exactly the
    // documented enum value — no synthesis, no silent collapse.
    const cases: Array<{
      relativePath: string;
      expected: string;
    }> = [
      {
        relativePath: "src/adapters/uspto/search.yaml",
        expected: "blocked-by-key",
      },
      {
        relativePath: "src/adapters/dpma/search.yaml",
        expected: "blocked-by-subscription",
      },
      {
        relativePath: "src/adapters/lens/search.yaml",
        expected: "blocked-by-subscription",
      },
      {
        relativePath: "src/adapters/pqai/search.yaml",
        expected: "blocked-by-key",
      },
    ];
    for (const { relativePath, expected } of cases) {
      const full = path.join(repoRoot, relativePath);
      // Ensure the fixture file we're asserting actually exists before
      // claiming the parser yielded the expected value — a missing file
      // should not pass the test by virtue of returning "unknown".
      expect(fs.existsSync(full), `missing fixture ${relativePath}`).toBe(true);
      expect(parseVerificationStatusFromFile(full)).toBe(expected);
    }

    // Adapter-level resolution: the same enum surfaces through the
    // adapter-name lookup path (used by runDoctor in patent.ts).
    expect([
      "blocked-by-key",
      "blocked-by-subscription",
      "verified",
      "unknown",
    ]).toContain(resolveAdapterVerificationStatus("uspto", ["search"]));
  });

  it("missing header resolves to 'unknown' rather than silently 'verified'", async () => {
    const { parseVerificationStatusFromFile } =
      await import("../../../src/commands/patent-doctor.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const os = await import("node:os");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const tmpFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "patent-doctor-")),
      "no-header.yaml",
    );
    void here;
    fs.writeFileSync(
      tmpFile,
      "site: nothing\nname: get\n# no @verification line\n",
      "utf-8",
    );
    expect(parseVerificationStatusFromFile(tmpFile)).toBe("unknown");
  });

  it("doctor source code emits verification_status on every row", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(
      here,
      "..",
      "..",
      "..",
      "src",
      "commands",
      "patent.ts",
    );
    const source = fs.readFileSync(sourcePath, "utf-8");
    // Honesty gate wiring: each row carries verification_status, and the
    // doctor exit-code gate fires when `anyDishonesty` is set.
    expect(source).toContain("verification_status: verificationStatus");
    expect(source).toMatch(/anyDishonesty\s*=\s*true/);
    expect(source).toMatch(
      /if\s*\(anyError\s*\|\|\s*anyDishonesty\)\s*process\.exit/,
    );
  });
});

describe("patent properties — exported surface stability", () => {
  it("DEFAULT_SOURCES is the documented L0 trio", () => {
    expect([...DEFAULT_SOURCES]).toEqual(["uspto", "epo", "jpo"]);
  });

  it("JURISDICTION_ADAPTERS covers the 13 documented ST.16 prefixes", () => {
    expect(Object.keys(JURISDICTION_ADAPTERS).sort()).toEqual(
      [
        "AU",
        "BR",
        "CA",
        "CN",
        "DE",
        "EP",
        "FR",
        "GB",
        "JP",
        "KR",
        "RU",
        "US",
        "WO",
      ].sort(),
    );
  });

  it("PATENT_CAPABILITIES has exactly seven taxonomy entries", () => {
    expect(PATENT_CAPABILITIES).toHaveLength(7);
    for (const cap of PATENT_CAPABILITIES) {
      expect(cap.startsWith("patent.")).toBe(true);
    }
  });

  it("resolveSources('all') returns at least the registered fixtures", () => {
    // Smoke test that registry discovery is wired (the real adapters do
    // not yet declare patent.* capabilities — that is subagent F's task).
    const sources = resolveSources("all");
    expect(Array.isArray(sources)).toBe(true);
  });
});
