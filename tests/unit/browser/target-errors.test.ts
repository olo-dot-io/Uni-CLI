/**
 * Tests for the ref-backed locator verification layer.
 *
 * Covers:
 *   - TargetError construction for each subtype
 *   - isTargetError predicate (positive + negative)
 *   - Fingerprint-map round-trip via a mock IPage
 *   - verifyRef: stale-ref / not-found / ambiguous / pass-through cases
 */

import { describe, it, expect } from "vitest";
import type { IPage } from "../../../src/types.js";
import {
  ambiguous,
  isTargetError,
  notFound,
  staleRef,
  TargetError,
} from "../../../src/browser/target-errors.js";
import {
  countMatches,
  extractRef,
  FINGERPRINT_PERSIST_JS,
  getSnapshotAge,
  listCandidates,
  readFingerprint,
  verifyRef,
} from "../../../src/browser/snapshot-identity.js";

// ── Mock IPage ─────────────────────────────────────────────────────────────

interface MockState {
  identity?: Record<string, unknown> | null;
  takenAt?: number | null;
  matches?: Record<string, number>;
}

function makeMockPage(state: MockState): {
  page: IPage;
  calls: string[];
} {
  const calls: string[] = [];
  const page = {
    async evaluate(expr: string): Promise<unknown> {
      calls.push(expr);
      // FINGERPRINT_PERSIST_JS — simulate by writing caller-provided state
      if (expr === FINGERPRINT_PERSIST_JS) {
        const now = Date.now();
        state.takenAt = now;
        state.identity = state.identity ?? {};
        return now;
      }
      // readFingerprint
      const refMatch = /m\[("([^"]+)")\] \|\| null/.exec(expr);
      if (refMatch) {
        const ref = refMatch[2];
        const entry = state.identity?.[ref];
        return entry ?? null;
      }
      // getSnapshotAge
      if (expr.includes("__unicli_ref_taken_at")) {
        const t = state.takenAt;
        return typeof t === "number" ? Date.now() - t : null;
      }
      // listCandidates
      if (
        expr.includes("__unicli_ref_identity") &&
        expr.includes("Object.keys")
      ) {
        const m = state.identity;
        if (!m) return [];
        return Object.keys(m).map((k) => {
          const entry = m[k] as { role?: string; name?: string } | null;
          return {
            ref: k,
            role: entry?.role ?? "unknown",
            name: entry?.name,
          };
        });
      }
      // countMatches — `document.querySelectorAll("selector").length`
      const countMatch = /document\.querySelectorAll\((.+)\)\.length/.exec(
        expr,
      );
      if (countMatch) {
        const selector = JSON.parse(countMatch[1]) as string;
        return state.matches?.[selector] ?? 0;
      }
      return null;
    },
  } as unknown as IPage;
  return { page, calls };
}

// ── TargetError construction ───────────────────────────────────────────────

describe("TargetError factories", () => {
  it("staleRef builds a stale_ref error with age + candidates", () => {
    const err = staleRef("12", 4200, [{ ref: "7", role: "button" }]);
    expect(err).toBeInstanceOf(TargetError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("TargetError");
    expect(err.detail.code).toBe("stale_ref");
    expect(err.detail.ref).toBe("12");
    expect(err.detail.snapshot_age_ms).toBe(4200);
    expect(err.detail.candidates).toEqual([{ ref: "7", role: "button" }]);
    expect(err.message).toContain("4200");
  });

  it("staleRef omits age when undefined", () => {
    const err = staleRef("12");
    expect(err.detail.snapshot_age_ms).toBeUndefined();
    expect(err.detail.candidates).toBeUndefined();
  });

  it("ambiguous carries the full candidate list", () => {
    const candidates = [
      { ref: "3", role: "button", name: "Submit" },
      { ref: "4", role: "button", name: "Submit" },
    ];
    const err = ambiguous("3", candidates);
    expect(err.detail.code).toBe("ambiguous");
    expect(err.detail.candidates).toEqual(candidates);
    expect(err.message).toContain("2 live elements");
  });

  it("notFound accepts an optional candidate list", () => {
    const err1 = notFound("9");
    expect(err1.detail.code).toBe("ref_not_found");
    expect(err1.detail.candidates).toBeUndefined();
    const err2 = notFound("9", [{ ref: "1", role: "link" }]);
    expect(err2.detail.candidates).toHaveLength(1);
  });
});

describe("isTargetError predicate", () => {
  it("returns true for TargetError instances", () => {
    expect(isTargetError(staleRef("1"))).toBe(true);
    expect(isTargetError(notFound("2"))).toBe(true);
    expect(isTargetError(ambiguous("3", []))).toBe(true);
  });

  it("returns false for plain Error / strings / undefined", () => {
    expect(isTargetError(new Error("boom"))).toBe(false);
    expect(isTargetError("string")).toBe(false);
    expect(isTargetError(undefined)).toBe(false);
    expect(isTargetError(null)).toBe(false);
    expect(isTargetError({ detail: { code: "stale_ref" } })).toBe(false);
  });
});

// ── extractRef ─────────────────────────────────────────────────────────────

describe("extractRef", () => {
  it("pulls the ref out of [data-unicli-ref='<N>']", () => {
    expect(extractRef('[data-unicli-ref="12"]')).toBe("12");
    expect(extractRef('[data-unicli-ref="42"]')).toBe("42");
  });

  it("accepts single-quoted attribute values", () => {
    expect(extractRef("[data-unicli-ref='12']")).toBe("12");
  });

  it("accepts unquoted attribute values", () => {
    expect(extractRef("[data-unicli-ref=7]")).toBe("7");
  });

  it("extracts ref from compound selectors", () => {
    expect(extractRef('button[data-unicli-ref="3"].primary')).toBe("3");
    expect(extractRef('div > [data-unicli-ref="9"]:hover')).toBe("9");
  });

  it("returns null for plain CSS selectors", () => {
    expect(extractRef("button.primary")).toBeNull();
    expect(extractRef("#login")).toBeNull();
    expect(extractRef('input[type="text"]')).toBeNull();
  });
});

// ── fingerprint round-trip ─────────────────────────────────────────────────

describe("fingerprint map round-trip", () => {
  it("readFingerprint returns entry when present", async () => {
    const state: MockState = {
      identity: { "7": { role: "button", name: "Go", taken_at: 1 } },
      takenAt: 1,
    };
    const { page } = makeMockPage(state);
    const entry = await readFingerprint(page, "7");
    expect(entry).toEqual({ role: "button", name: "Go", taken_at: 1 });
  });

  it("readFingerprint returns null for missing ref", async () => {
    const state: MockState = { identity: {}, takenAt: 1 };
    const { page } = makeMockPage(state);
    expect(await readFingerprint(page, "99")).toBeNull();
  });

  it("readFingerprint returns null for malformed global (missing role)", async () => {
    const state: MockState = {
      identity: { "1": { taken_at: 1 } }, // no `role` field
      takenAt: 1,
    };
    const { page } = makeMockPage(state);
    expect(await readFingerprint(page, "1")).toBeNull();
  });

  it("readFingerprint returns null when entry is a non-object", async () => {
    const state: MockState = {
      identity: { "1": "not-an-object" },
      takenAt: 1,
    };
    const { page } = makeMockPage(state);
    expect(await readFingerprint(page, "1")).toBeNull();
  });

  it("getSnapshotAge returns ms delta when taken_at is set", async () => {
    const state: MockState = { takenAt: Date.now() - 100 };
    const { page } = makeMockPage(state);
    const age = await getSnapshotAge(page);
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(100);
  });

  it("getSnapshotAge returns null when never taken", async () => {
    const { page } = makeMockPage({ takenAt: null });
    expect(await getSnapshotAge(page)).toBeNull();
  });

  it("listCandidates returns empty for no identity map", async () => {
    const { page } = makeMockPage({ identity: null });
    expect(await listCandidates(page)).toEqual([]);
  });

  it("listCandidates flattens the map into candidate records", async () => {
    const state: MockState = {
      identity: {
        "1": { role: "button", name: "A", taken_at: 1 },
        "2": { role: "link", name: "B", taken_at: 1 },
      },
      takenAt: 1,
    };
    const { page } = makeMockPage(state);
    const cands = await listCandidates(page);
    expect(cands).toHaveLength(2);
    expect(cands[0]).toMatchObject({ ref: "1", role: "button", name: "A" });
  });

  it("countMatches reads selector count", async () => {
    const state: MockState = { matches: { "button.primary": 3 } };
    const { page } = makeMockPage(state);
    expect(await countMatches(page, "button.primary")).toBe(3);
    expect(await countMatches(page, "missing")).toBe(0);
  });
});

// ── verifyRef behavior ─────────────────────────────────────────────────────

describe("verifyRef", () => {
  it("is a no-op for plain CSS selectors (backward compat)", async () => {
    const { page } = makeMockPage({});
    await expect(verifyRef(page, "button.primary")).resolves.toBeUndefined();
  });

  it("throws stale_ref when no fingerprint exists for the ref", async () => {
    const state: MockState = {
      identity: {}, // empty map → ref missing
      takenAt: Date.now() - 500,
      matches: { '[data-unicli-ref="12"]': 1 },
    };
    const { page } = makeMockPage(state);
    try {
      await verifyRef(page, '[data-unicli-ref="12"]');
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(isTargetError(err)).toBe(true);
      if (!isTargetError(err)) throw err;
      expect(err.detail.code).toBe("stale_ref");
      expect(err.detail.ref).toBe("12");
      expect(err.detail.snapshot_age_ms).toBeGreaterThanOrEqual(500);
    }
  });

  it("throws ref_not_found when zero elements match the selector", async () => {
    const state: MockState = {
      identity: {
        "12": { role: "button", name: "Go", taken_at: Date.now() },
      },
      takenAt: Date.now(),
      matches: { '[data-unicli-ref="12"]': 0 },
    };
    const { page } = makeMockPage(state);
    try {
      await verifyRef(page, '[data-unicli-ref="12"]');
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(isTargetError(err)).toBe(true);
      if (!isTargetError(err)) throw err;
      expect(err.detail.code).toBe("ref_not_found");
      expect(err.detail.ref).toBe("12");
    }
  });

  it("throws ambiguous when >1 elements match the selector", async () => {
    const state: MockState = {
      identity: {
        "12": { role: "button", name: "Go", taken_at: Date.now() },
        "13": { role: "button", name: "Also Go", taken_at: Date.now() },
      },
      takenAt: Date.now(),
      matches: { '[data-unicli-ref="12"]': 2 },
    };
    const { page } = makeMockPage(state);
    try {
      await verifyRef(page, '[data-unicli-ref="12"]');
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(isTargetError(err)).toBe(true);
      if (!isTargetError(err)) throw err;
      expect(err.detail.code).toBe("ambiguous");
      expect(err.detail.candidates).toBeDefined();
      expect(err.detail.candidates!.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("passes through silently when the ref binds 1:1", async () => {
    const state: MockState = {
      identity: {
        "12": { role: "button", name: "Go", taken_at: Date.now() },
      },
      takenAt: Date.now(),
      matches: { '[data-unicli-ref="12"]': 1 },
    };
    const { page } = makeMockPage(state);
    await expect(
      verifyRef(page, '[data-unicli-ref="12"]'),
    ).resolves.toBeUndefined();
  });

  it("falls back to stale_ref when the fingerprint global is malformed", async () => {
    const state: MockState = {
      identity: { "12": { taken_at: Date.now() } }, // missing `role`
      takenAt: Date.now(),
      matches: { '[data-unicli-ref="12"]': 1 },
    };
    const { page } = makeMockPage(state);
    try {
      await verifyRef(page, '[data-unicli-ref="12"]');
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(isTargetError(err)).toBe(true);
      if (!isTargetError(err)) throw err;
      expect(err.detail.code).toBe("stale_ref");
    }
  });

  it("counts ref uniqueness via canonical selector (ignores compound narrowing)", async () => {
    const state: MockState = {
      identity: {
        "3": { role: "button", name: "Submit", taken_at: Date.now() },
        "4": { role: "button", name: "Submit", taken_at: Date.now() },
      },
      takenAt: Date.now(),
      // Compound selector matches 1, but canonical matches 2 → ambiguous.
      matches: {
        'button[data-unicli-ref="3"].primary': 1,
        '[data-unicli-ref="3"]': 2,
      },
    };
    const { page } = makeMockPage(state);
    try {
      await verifyRef(page, 'button[data-unicli-ref="3"].primary');
      expect.unreachable("should have thrown ambiguous");
    } catch (err) {
      expect(isTargetError(err)).toBe(true);
      if (!isTargetError(err)) throw err;
      expect(err.detail.code).toBe("ambiguous");
    }
  });
});
