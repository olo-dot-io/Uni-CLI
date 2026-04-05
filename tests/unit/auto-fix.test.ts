import { describe, it, expect } from "vitest";
import { suggestSelectFix } from "../../src/engine/auto-fix.js";

describe("auto-fix", () => {
  it("suggests alternative paths when data has different structure", () => {
    const data = { result: { list: [1, 2, 3] } };
    const suggestions = suggestSelectFix(data, "data.items");
    expect(suggestions).toContain("result.list");
  });

  it("returns empty array when data is null", () => {
    expect(suggestSelectFix(null, "data.items")).toEqual([]);
  });

  it("finds array fields in nested objects", () => {
    const data = { response: { data: { entries: [{ id: 1 }] } } };
    const suggestions = suggestSelectFix(data, "items");
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.some((s) => s.includes("entries"))).toBe(true);
  });

  it("filters out the failed path from suggestions", () => {
    const data = { items: [1, 2], other: [3, 4] };
    const suggestions = suggestSelectFix(data, "items");
    expect(suggestions).not.toContain("items");
    expect(suggestions).toContain("other");
  });

  it("handles deeply nested structures up to depth 5", () => {
    const data = { a: { b: { c: { d: { e: { f: [1] } } } } } };
    const suggestions = suggestSelectFix(data, "x");
    expect(suggestions).toContain("a.b.c.d.e.f");
  });

  it("stops at depth 5", () => {
    const data = { a: { b: { c: { d: { e: { f: { g: [1] } } } } } } };
    const suggestions = suggestSelectFix(data, "x");
    // g is at depth 6, should not be found
    expect(suggestions).not.toContain("a.b.c.d.e.f.g");
  });
});
