/**
 * Legacy formatter tests — re-baselined for v2 envelope contract (Task 3).
 *
 * The new format() signature requires a ctx param. Tests that previously
 * asserted on raw array JSON/YAML/MD output now assert on envelope structure.
 * csv/compact are unchanged (array-only legacy paths).
 */
import { describe, it, expect, vi } from "vitest";
import { format, detectFormat } from "../../src/output/formatter.js";
import type { AgentContext } from "../../src/output/envelope.js";

const ctx: AgentContext = {
  command: "test.cmd",
  duration_ms: 10,
  surface: "web",
};

const sampleData = [
  { name: "Alice", score: 100 },
  { name: "Bob", score: 85 },
];

describe("output formatter — csv/compact (unchanged array paths)", () => {
  it("formats as CSV", () => {
    const result = format(sampleData, ["name", "score"], "csv", ctx);
    const lines = result.split("\n");
    expect(lines[0]).toBe("name,score");
    expect(lines[1]).toBe("Alice,100");
    expect(lines[2]).toBe("Bob,85");
  });

  it("formats as compact (pipe-separated, newline-delimited, no headers)", () => {
    const result = format(sampleData, ["name", "score"], "compact", ctx);
    const lines = result.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("Alice|100");
    expect(lines[1]).toBe("Bob|85");
  });

  it("compact format handles values with pipe by replacing them", () => {
    const data = [{ a: "x|y", b: 1 }];
    const result = format(data, ["a", "b"], "compact", ctx);
    expect(result).not.toContain("x|y|");
  });

  it("compact format omits embedded newlines in values", () => {
    const data = [{ a: "line1\nline2", b: 1 }];
    const result = format(data, ["a", "b"], "compact", ctx);
    expect(result.split("\n")).toHaveLength(1);
  });

  it("handles empty data for csv", () => {
    const csv = format([], ["name"], "csv", ctx);
    expect(csv).toBe("");
  });

  it("handles empty data for compact", () => {
    const compact = format([], ["name"], "compact", ctx);
    expect(compact).toBe("");
  });
});

describe("output formatter — envelope formats (json/yaml/md)", () => {
  it("formats as JSON v2 envelope", () => {
    const result = format(sampleData, ["name", "score"], "json", ctx);
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.schema_version).toBe("2");
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data[0].name).toBe("Alice");
    expect(parsed.meta.count).toBe(2);
    expect(parsed.command).toBe("test.cmd");
  });

  it("formats as Markdown v2 envelope (frontmatter + data section)", () => {
    const result = format(sampleData, ["name", "score"], "md", ctx);
    expect(result).toContain("ok: true");
    expect(result).toContain('schema_version: "2"');
    expect(result).toContain("## Data");
  });

  it("formats as YAML v2 envelope", () => {
    const result = format(sampleData, ["name", "score"], "yaml", ctx);
    expect(result).toContain("ok: true");
    expect(result).toContain('schema_version: "2"');
  });

  it("table format emits deprecation warning and falls back to md envelope", () => {
    const warn = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const result = format(sampleData, ["name", "score"], "table", ctx);
    expect(warn).toHaveBeenCalled();
    const warning = String(warn.mock.calls[0]?.[0] ?? "");
    expect(warning).toMatch(/deprecated/i);
    expect(warning).toMatch(/md/i);
    // Output should be md envelope now (not raw table)
    expect(result).toContain("ok: true");
    warn.mockRestore();
  });
});

describe("detectFormat", () => {
  it("passes through explicit value", () => {
    expect(detectFormat("json")).toBe("json");
    expect(detectFormat("compact")).toBe("compact");
    expect(detectFormat("md")).toBe("md");
  });

  it("returns md when stdout is not a TTY (changed from json in v0.213)", () => {
    const stored = process.stdout.isTTY;
    try {
      Object.defineProperty(process.stdout, "isTTY", {
        value: false,
        configurable: true,
      });
      expect(detectFormat()).toBe("md");
    } finally {
      Object.defineProperty(process.stdout, "isTTY", {
        value: stored,
        configurable: true,
      });
    }
  });
});
