/**
 * observe — pure ranker tests. We test the scoring function in isolation
 * (no DOM, no network) so the test can run offline and quickly. The
 * end-to-end browser path is exercised by the operate.test.ts harness.
 */

import { describe, it, expect } from "vitest";
import {
  tokenize,
  scoreCandidate,
  rankCandidates,
  actionForTag,
  type SnapshotRef,
} from "../../src/browser/observe.js";

describe("tokenize", () => {
  it("lowercases and splits on whitespace + punctuation", () => {
    expect(tokenize("Submit Form!")).toEqual(["submit", "form"]);
  });
  it("keeps Chinese characters", () => {
    expect(tokenize("提交 表单")).toEqual(["提交", "表单"]);
  });
  it("returns [] for empty input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });
});

describe("scoreCandidate", () => {
  const submitButton: SnapshotRef = {
    ref: 1,
    tag: "button",
    text: "Submit",
  };
  const cancelLink: SnapshotRef = {
    ref: 2,
    tag: "a",
    text: "Cancel",
  };
  const searchInput: SnapshotRef = {
    ref: 3,
    tag: "input",
    text: "",
    attrs: { "aria-label": "Search bar", placeholder: "Search…" },
  };

  it("scores 0.95 on exact label match", () => {
    const r = scoreCandidate(submitButton, ["submit"]);
    expect(r.confidence).toBe(0.95);
    expect(r.reason).toContain("exact");
  });

  it("scores 0.85 when all query tokens are in label", () => {
    const r = scoreCandidate({ ref: 4, tag: "button", text: "Submit Form" }, [
      "submit",
    ]);
    expect(r.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("partial match scales with ratio", () => {
    const r = scoreCandidate({ ref: 5, tag: "button", text: "Submit Form" }, [
      "submit",
      "the",
      "form",
      "now",
    ]);
    // 2 of 4 tokens match → 0.4 + 0.5 * 0.4 = 0.6
    expect(r.confidence).toBeGreaterThan(0.5);
    expect(r.confidence).toBeLessThan(0.85);
  });

  it("tag bonus for explicit role mention", () => {
    const r = scoreCandidate(submitButton, ["button"]);
    expect(r.confidence).toBeGreaterThan(0);
  });

  it("aria-label bonus for inputs without text", () => {
    const r = scoreCandidate(searchInput, ["search"]);
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.reason).toContain("aria-label");
  });

  it("zero confidence for unrelated query", () => {
    expect(
      scoreCandidate(submitButton, ["delete", "everything"]).confidence,
    ).toBe(0);
  });

  it("zero confidence for empty query tokens", () => {
    expect(scoreCandidate(submitButton, []).confidence).toBe(0);
  });
});

describe("actionForTag", () => {
  it("input → type", () => {
    expect(actionForTag("input")).toBe("type");
    expect(actionForTag("INPUT")).toBe("type");
  });
  it("textarea → type", () => {
    expect(actionForTag("textarea")).toBe("type");
  });
  it("select → select", () => {
    expect(actionForTag("select")).toBe("select");
  });
  it("button / a / div → click", () => {
    expect(actionForTag("button")).toBe("click");
    expect(actionForTag("a")).toBe("click");
    expect(actionForTag("div")).toBe("click");
  });
});

describe("rankCandidates", () => {
  const refs: SnapshotRef[] = [
    { ref: 1, tag: "button", text: "Submit" },
    { ref: 2, tag: "a", text: "Cancel" },
    { ref: 3, tag: "input", text: "", attrs: { "aria-label": "Search bar" } },
    { ref: 4, tag: "button", text: "Save Draft" },
    { ref: 5, tag: "button", text: "Submit and Continue" },
  ];

  it("ranks the exact match first", () => {
    const ranked = rankCandidates(refs, "Submit", 3);
    expect(ranked[0].ref).toBe(1);
    expect(ranked[0].confidence).toBeGreaterThan(0.9);
  });

  it("respects topK", () => {
    const ranked = rankCandidates(refs, "Submit", 2);
    expect(ranked.length).toBeLessThanOrEqual(2);
  });

  it("returns selectors in [data-unicli-ref] form", () => {
    const ranked = rankCandidates(refs, "submit", 5);
    for (const c of ranked) {
      expect(c.selector).toMatch(/^\[data-unicli-ref="\d+"\]$/);
    }
  });

  it("infers action by tag", () => {
    const ranked = rankCandidates(refs, "search bar", 5);
    expect(ranked[0].action).toBe("type");
  });

  it("drops candidates with zero confidence", () => {
    const ranked = rankCandidates(refs, "definitely-not-on-page-xyz", 5);
    expect(ranked).toHaveLength(0);
  });

  it("returns label fallback for empty-text refs", () => {
    const noText: SnapshotRef[] = [
      { ref: 9, tag: "input", text: "", attrs: { "aria-label": "Email" } },
    ];
    const ranked = rankCandidates(noText, "email", 1);
    expect(ranked[0].label).toBe("Email");
  });
});
