import { describe, it, expect, vi } from "vitest";
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

  it("formats as YAML", () => {
    const result = format(sampleData, ["name", "score"], "yaml");
    expect(result).toContain("name: Alice");
    expect(result).toContain("score: 100");
    expect(result).toContain("name: Bob");
  });

  it("formats as compact (pipe-separated, newline-delimited, no headers)", () => {
    const result = format(sampleData, ["name", "score"], "compact");
    const lines = result.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("Alice|100");
    expect(lines[1]).toBe("Bob|85");
  });

  it("compact format handles values with pipe by replacing them", () => {
    const data = [{ a: "x|y", b: 1 }];
    const result = format(data, ["a", "b"], "compact");
    // Pipe in values is escaped so the line stays parseable.
    expect(result).not.toContain("x|y|");
  });

  it("compact format omits embedded newlines in values", () => {
    const data = [{ a: "line1\nline2", b: 1 }];
    const result = format(data, ["a", "b"], "compact");
    expect(result.split("\n")).toHaveLength(1);
  });

  it("handles empty data", () => {
    const json = format([], ["name"], "json");
    expect(json).toBe("[]");
    const compact = format([], ["name"], "compact");
    expect(compact).toBe("");
  });

  it("table format emits deprecation warning and falls back to md", () => {
    const warn = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const result = format(sampleData, ["name", "score"], "table");
    expect(warn).toHaveBeenCalled();
    const warning = String(warn.mock.calls[0]?.[0] ?? "");
    expect(warning).toMatch(/deprecated/i);
    expect(warning).toMatch(/md/i);
    // Output should match the md format.
    expect(result).toContain("| name | score |");
    warn.mockRestore();
  });

  it("detects format with explicit value pass-through", () => {
    expect(detectFormat("json")).toBe("json");
    expect(detectFormat("compact")).toBe("compact");
    expect(detectFormat("md")).toBe("md");
  });

  it("detectFormat falls back to json when stdout is not a TTY", () => {
    const stored = process.stdout.isTTY;
    try {
      Object.defineProperty(process.stdout, "isTTY", {
        value: false,
        configurable: true,
      });
      expect(detectFormat()).toBe("json");
    } finally {
      Object.defineProperty(process.stdout, "isTTY", {
        value: stored,
        configurable: true,
      });
    }
  });
});
