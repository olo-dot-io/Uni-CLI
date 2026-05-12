import { describe, expect, it } from "vitest";
import {
  formatOeisId,
  mapOeisSearchRows,
  mapOeisSequenceRow,
  previewOeisTerms,
  requireOeisLimit,
  requireOeisSequenceId,
} from "./sequences.js";

describe("oeis agent-facing sequence commands", () => {
  it("validates ids and limits", () => {
    expect(requireOeisLimit(undefined)).toBe(10);
    expect(requireOeisLimit("100")).toBe(100);
    expect(() => requireOeisLimit("101")).toThrow("oeis limit must");
    expect(requireOeisSequenceId("https://oeis.org/A000045")).toBe("A000045");
    expect(() => requireOeisSequenceId("B45")).toThrow("valid A-number");
  });

  it("formats ids and term previews", () => {
    expect(formatOeisId(45)).toBe("A000045");
    expect(previewOeisTerms("1, 1,2,3", 3)).toBe("1, 1, 2, (+1)");
  });

  it("maps search rows", () => {
    expect(
      mapOeisSearchRows([
        {
          number: 45,
          name: "Fibonacci numbers",
          keyword: "nonn,easy",
          data: "0,1,1,2,3,5,8",
          author: "N. J. A. Sloane",
          created: "1964-01-01",
        },
      ]),
    ).toMatchObject([
      {
        rank: 1,
        id: "A000045",
        name: "Fibonacci numbers",
        preview: "0, 1, 1, 2, 3, 5, 8",
        url: "https://oeis.org/A000045",
      },
    ]);
  });

  it("maps sequence detail rows", () => {
    expect(
      mapOeisSequenceRow(
        {
          number: 45,
          data: "0,1,1",
          revision: 100,
          comment: ["a"],
          formula: ["b"],
          reference: ["c"],
          xref: ["d"],
          link: ["e"],
        },
        "A000045",
      ),
    ).toMatchObject({
      id: "A000045",
      termCount: 3,
      revision: 100,
      commentCount: 1,
      formulaCount: 1,
    });
  });
});
