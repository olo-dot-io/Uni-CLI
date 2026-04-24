import { describe, expect, it } from "vitest";
import {
  deriveFixture,
  expandFixtureArgs,
  validateRows,
} from "../../../src/browser/verify-fixture.js";

describe("browser verify fixture", () => {
  it("derives structural expectations from adapter rows", () => {
    const fixture = deriveFixture(
      [
        { title: "First", score: 1 },
        { title: "Second", score: "2" },
      ],
      { limit: 2 },
    );

    expect(fixture).toEqual({
      args: { limit: 2 },
      expect: {
        rowCount: { min: 1 },
        columns: ["title", "score"],
        types: { title: "string", score: "number|string" },
      },
    });
  });

  it("catches silent fallback and content contamination failures", () => {
    const failures = validateRows([{ title: "address: leaked", score: 0 }], {
      expect: {
        mustNotContain: { title: ["address:"] },
        mustBeTruthy: ["score"],
      },
    });

    expect(failures.map((f) => f.rule)).toEqual([
      "mustNotContain",
      "mustBeTruthy",
    ]);
  });

  it("expands object and array fixture args", () => {
    expect(expandFixtureArgs({ limit: 3, query: "ai" })).toEqual([
      "--limit",
      "3",
      "--query",
      "ai",
    ]);
    expect(expandFixtureArgs(["topic", "--limit", 3])).toEqual([
      "topic",
      "--limit",
      "3",
    ]);
  });
});
