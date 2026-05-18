/**
 * @owner   tests/unit/public-surface/patent.test.ts
 * @does    Assert the patent vertical's public surface re-exports the names
 *          third-party consumers depend on. Guards against accidental rename
 *          or removal of a published type / helper between minor versions.
 * @needs   src/index.ts
 * @feeds   npm run test (unit project), npm run verify
 * @breaks  Test fails if a public-surface export disappears or is renamed
 *          without a semver-major bump.
 */

import { describe, expect, it } from "vitest";

import * as pkg from "../../../src/index.js";

// Names that ship as part of the patent vertical's public API. Each entry
// here is part of @zenalexa/unicli's semver contract — additions are minor,
// removals are major.
const PUBLIC_NAMES: readonly string[] = [
  // Helpers
  "canonicalizePublicationNumber",
  "dedupeByFamily",
];

describe("public surface — patent vertical", () => {
  it("re-exports the runtime helpers third-party consumers depend on", () => {
    for (const name of PUBLIC_NAMES) {
      expect(
        pkg,
        `expected src/index.ts to re-export "${name}"`,
      ).toHaveProperty(name);
    }
  });

  it("canonicalizePublicationNumber is callable", () => {
    expect(typeof pkg.canonicalizePublicationNumber).toBe("function");
    // Smoke — the segmentation lives in patent-envelope.ts; we just confirm
    // the re-export wires through without a level of indirection that breaks
    // runtime callability.
    expect(pkg.canonicalizePublicationNumber("US20240123456A1")).toBe(
      "US-20240123456-A1",
    );
  });

  it("dedupeByFamily is callable", () => {
    expect(typeof pkg.dedupeByFamily).toBe("function");
    const stamp = "2026-05-18T00:00:00.000Z";
    const result = pkg.dedupeByFamily([
      {
        publication_number: "US-1-A1",
        source_adapter: "uspto",
        retrieved_at: stamp,
        family_id: "F-1",
      },
      {
        publication_number: "EP-2-A1",
        source_adapter: "epo",
        retrieved_at: stamp,
        family_id: "F-1",
      },
    ]);
    expect(result).toHaveLength(1);
  });

  // Type-only re-exports cannot be tested with `toHaveProperty` (they are
  // erased at runtime), but they are exercised at compile time by the
  // following import: if any of these names disappears from src/index.ts,
  // `tsc --noEmit` (npm run typecheck) fails before this test ever runs.
  it("type re-exports compile (verified at typecheck time)", () => {
    // Cast to a tagged tuple so the type names are referenced at compile
    // time. The runtime value is unused.
    type _Types = [
      pkg.PatentRecord,
      pkg.PatentCommand,
      pkg.PatentSearchQuery,
      pkg.PatentParty,
      pkg.PatentClassification,
      pkg.PatentFamilyMember,
      pkg.PatentEnvelope,
      pkg.PatentErrorCode,
      pkg.PatentVerificationStatus,
    ];
    // Reference _Types so noUnusedLocals does not strip it.
    const witness: _Types | undefined = undefined;
    expect(witness).toBeUndefined();
  });
});
