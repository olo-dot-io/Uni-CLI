/**
 * Unit tests for truncateDescription and annotateIfLarge — helpers exported
 * from src/mcp/server.ts.
 */

import { describe, it, expect } from "vitest";
import { truncateDescription, annotateIfLarge } from "../../src/mcp/server.js";

function approxTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.3);
}

describe("truncateDescription", () => {
  it("returns short strings unchanged", () => {
    const desc = "[hackernews] Fetch top stories from Hacker News";
    expect(truncateDescription(desc)).toBe(desc);
  });

  it("truncates long descriptions at word boundary", () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    const result = truncateDescription(words);
    expect(result.endsWith("…")).toBe(true);
    expect(approxTokens(result)).toBeLessThanOrEqual(68);
  });

  it("respects custom maxTokens", () => {
    const desc = "one two three four five six seven eight nine ten";
    const result = truncateDescription(desc, 10);
    expect(approxTokens(result)).toBeLessThanOrEqual(10);
    expect(result.endsWith("…")).toBe(true);
  });

  it("handles single word that exceeds budget", () => {
    const desc = "superlongword";
    const result = truncateDescription(desc, 1);
    expect(result).toBe("superlongword …");
  });

  it("handles empty string", () => {
    expect(truncateDescription("")).toBe("");
  });
});

describe("annotateIfLarge", () => {
  it("passes through small results unchanged (no _meta field)", () => {
    const result = {
      content: [{ type: "text" as const, text: "short result" }],
    };
    const out = annotateIfLarge(result);
    expect(out._meta).toBeUndefined();
    expect(out.content).toStrictEqual(result.content);
  });

  it("annotates large results with anthropic/maxResultSizeChars", () => {
    // Build a string larger than 10 KB (10_000 chars)
    const bigText = "x".repeat(10_001);
    const result = {
      content: [{ type: "text" as const, text: bigText }],
    };
    const out = annotateIfLarge(result);
    expect(out._meta).toBeDefined();
    expect(out._meta!["anthropic/maxResultSizeChars"]).toBe(500_000);
  });

  it("annotates large error results with _meta", () => {
    const bigText = "e".repeat(10_001);
    const result = {
      content: [{ type: "text" as const, text: bigText }],
      isError: true as const,
    };
    const out = annotateIfLarge(result);
    expect(out._meta).toBeDefined();
    expect(out._meta!["anthropic/maxResultSizeChars"]).toBe(500_000);
    expect(out.isError).toBe(true);
  });
});
