/**
 * Tests for the schema-v2 lint engine (src/commands/lint.ts).
 *
 * Each test writes a synthetic YAML adapter into a tmp directory and
 * invokes `lintAdapterFile` / `lintPath` directly. No network, no
 * subprocess — the engine is pure.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lintAdapterFile, lintPath } from "../../src/commands/lint.js";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "unicli-lint-"));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeAdapter(
  relPath: string,
  content: string | Record<string, unknown>,
): string {
  const fullPath = join(tmpRoot, relPath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  const text =
    typeof content === "string"
      ? content
      : Object.entries(content)
          .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
          .join("\n");
  writeFileSync(fullPath, text, "utf-8");
  return fullPath;
}

// Schema-v2 metadata that every fixture needs so the v2 gate doesn't
// light up in tests that don't care about it.
const V2_FOOTER = [
  'capabilities: ["http.fetch"]',
  "minimum_capability: http.fetch",
  "trust: public",
  "confidentiality: public",
  "quarantine: false",
];

describe("unicli lint — per-file", () => {
  it("passes a minimal valid adapter", () => {
    const file = writeAdapter(
      "ok/search.yaml",
      [
        "site: ok",
        "name: search",
        "type: web-api",
        "strategy: public",
        "pipeline:",
        "  - fetch:",
        "      url: https://example.com/api",
        ...V2_FOOTER,
      ].join("\n"),
    );
    const issues = lintAdapterFile(file);
    expect(issues).toEqual([]);
  });

  it("flags invalid YAML as a parse error", () => {
    const file = writeAdapter(
      "bad/broken.yaml",
      "site: ok\nname: x\npipeline:\n  - fetch: { url: [unterminated",
    );
    const issues = lintAdapterFile(file);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].rule).toBe("parse");
    expect(issues[0].severity).toBe("error");
  });

  it("rejects an unknown pipeline step", () => {
    const file = writeAdapter(
      "bad/step.yaml",
      [
        "site: bad",
        "name: step",
        "type: web-api",
        "pipeline:",
        "  - fetch: { url: https://example.com }",
        "  - teleport: { destination: mars }",
      ].join("\n"),
    );
    const issues = lintAdapterFile(file);
    const unknown = issues.find((i) => i.rule === "unknown-step");
    expect(unknown).toBeDefined();
    expect(unknown!.message).toContain("teleport");
    expect(unknown!.severity).toBe("error");
  });

  it("rejects an invalid type", () => {
    const file = writeAdapter(
      "bad/type.yaml",
      [
        "site: bad",
        "name: type",
        "type: lunar",
        "pipeline:",
        "  - fetch: { url: https://example.com }",
      ].join("\n"),
    );
    const issues = lintAdapterFile(file);
    const typeIssue = issues.find((i) => i.rule === "schema");
    expect(typeIssue).toBeDefined();
    expect(typeIssue!.severity).toBe("error");
    expect(typeIssue!.message).toContain("lunar");
  });

  it("rejects an invalid strategy", () => {
    const file = writeAdapter(
      "bad/strategy.yaml",
      [
        "site: bad",
        "name: strategy",
        "type: web-api",
        "strategy: carrier-pigeon",
        "pipeline:",
        "  - fetch: { url: https://example.com }",
      ].join("\n"),
    );
    const issues = lintAdapterFile(file);
    const strategyIssue = issues.find(
      (i) => i.rule === "schema" && i.message.includes("strategy"),
    );
    expect(strategyIssue).toBeDefined();
    expect(strategyIssue!.severity).toBe("error");
  });

  it("requires quarantineReason when quarantine: true", () => {
    const file = writeAdapter(
      "bad/quar.yaml",
      [
        "site: bad",
        "name: quar",
        "type: web-api",
        "quarantine: true",
        "pipeline:",
        "  - fetch: { url: https://example.com }",
      ].join("\n"),
    );
    const issues = lintAdapterFile(file);
    const qIssue = issues.find((i) => i.rule === "quarantine");
    expect(qIssue).toBeDefined();
    expect(qIssue!.severity).toBe("error");
    expect(qIssue!.message).toContain("quarantineReason");
  });

  it("warns when quarantineReason is present without quarantine: true", () => {
    const file = writeAdapter(
      "warn/quar.yaml",
      [
        "site: warn",
        "name: quar",
        "type: web-api",
        'quarantineReason: "upstream dead"',
        "pipeline:",
        "  - fetch: { url: https://example.com }",
        ...V2_FOOTER,
      ].join("\n"),
    );
    const issues = lintAdapterFile(file);
    const qWarn = issues.find((i) => i.rule === "quarantine");
    expect(qWarn).toBeDefined();
    expect(qWarn!.severity).toBe("warning");
    // Not an error — no failure count bump.
    expect(issues.every((i) => i.severity !== "error")).toBe(true);
  });

  it("walks nested if/each sub-pipelines for step-name validation", () => {
    const file = writeAdapter(
      "bad/nested.yaml",
      [
        "site: bad",
        "name: nested",
        "type: web-api",
        "pipeline:",
        "  - if:",
        "      condition: true",
        "      then:",
        "        - fetch: { url: https://example.com }",
        "      else:",
        "        - teleport: {}",
      ].join("\n"),
    );
    const issues = lintAdapterFile(file);
    const unknown = issues.find((i) => i.rule === "unknown-step");
    expect(unknown).toBeDefined();
    expect(unknown!.message).toContain("teleport");
  });

  it("accepts a quarantined adapter with a reason", () => {
    const file = writeAdapter(
      "ok/quarantined.yaml",
      [
        "site: ok",
        "name: quarantined",
        "type: web-api",
        "quarantine: true",
        'quarantineReason: "API v1 deprecated 2025-11"',
        "pipeline:",
        "  - fetch: { url: https://example.com/v1 }",
        'capabilities: ["http.fetch"]',
        "minimum_capability: http.fetch",
        "trust: public",
        "confidentiality: public",
      ].join("\n"),
    );
    const issues = lintAdapterFile(file);
    expect(issues).toEqual([]);
  });

  it("flags empty pipeline as a warning (not error)", () => {
    const file = writeAdapter(
      "warn/empty.yaml",
      ["site: warn", "name: empty", "type: web-api", "pipeline: []"].join("\n"),
    );
    const issues = lintAdapterFile(file);
    const pipelineIssue = issues.find((i) => i.rule === "pipeline");
    expect(pipelineIssue).toBeDefined();
    expect(pipelineIssue!.severity).toBe("warning");
  });
});

describe("unicli lint — directory walk", () => {
  it("aggregates scan results into a report", () => {
    // Use the pre-seeded tmpRoot with all above fixtures.
    const report = lintPath(tmpRoot);
    expect(report.scanned).toBeGreaterThan(0);
    // ok/* files must be in the passed bucket
    expect(report.passed).toBeGreaterThanOrEqual(2);
    // bad/* files must be in the failed bucket
    expect(report.failed).toBeGreaterThanOrEqual(4);
    // warnings include the two warn/* files
    expect(report.warnings).toBeGreaterThanOrEqual(2);
  });

  it("returns an empty report for a directory with no YAML", () => {
    const empty = join(tmpRoot, "no-yaml");
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, "README.md"), "no adapters here", "utf-8");
    const report = lintPath(empty);
    expect(report.scanned).toBe(0);
    expect(report.issues).toEqual([]);
  });
});

describe("unicli lint — production adapters", () => {
  it("lints every built-in adapter without fatal errors", () => {
    // Smoke test: the production src/adapters/ tree must lint clean.
    // Warnings allowed; errors are not.
    const report = lintPath("src/adapters");
    expect(report.scanned).toBeGreaterThan(100);
    if (report.failed > 0) {
      const first = report.issues
        .filter((i) => i.severity === "error")
        .slice(0, 3);
      throw new Error(
        `lint errors in built-in adapters:\n${first
          .map((i) => `  ${i.file}: [${i.rule}] ${i.message}`)
          .join("\n")}`,
      );
    }
    expect(report.failed).toBe(0);
  });
});
