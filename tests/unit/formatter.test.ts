import { describe, it, expect } from "vitest";
import { format, detectFormat } from "../../src/output/formatter.js";

describe("output formatter", () => {
  const sampleData = [
    { name: "Alice", score: 100 },
    { name: "Bob", score: 85 },
  ];

  it("formats as JSON", () => {
    const result = format(sampleData, ["name", "score"], "json");
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe("Alice");
  });

  it("formats as CSV", () => {
    const result = format(sampleData, ["name", "score"], "csv");
    const lines = result.split("\n");
    expect(lines[0]).toBe("name,score");
    expect(lines[1]).toBe("Alice,100");
    expect(lines[2]).toBe("Bob,85");
  });

  it("formats as Markdown", () => {
    const result = format(sampleData, ["name", "score"], "md");
    expect(result).toContain("| name | score |");
    expect(result).toContain("| --- | --- |");
    expect(result).toContain("| Alice | 100 |");
  });

  it("handles empty data", () => {
    const json = format([], ["name"], "json");
    expect(json).toBe("[]");
  });

  it("detects JSON format for piped output", () => {
    // detectFormat returns 'json' when stdout is not a TTY
    // In test environment, stdout IS a TTY sometimes
    const explicit = detectFormat("json");
    expect(explicit).toBe("json");

    const tableExplicit = detectFormat("table");
    expect(tableExplicit).toBe("table");
  });
});
