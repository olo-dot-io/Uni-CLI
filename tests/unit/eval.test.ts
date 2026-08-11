/**
 * Eval harness — judges, file loading, runner shape.
 *
 * The runner itself shells out to `unicli` which would require a built
 * binary. We test the *parts*: judge logic, path picker, file loader,
 * and the discovery walker. The end-to-end execSync path is exercised
 * by the existing repair/eval.ts test path.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyJudge,
  loadEvalFile,
  type Judge,
} from "../../src/commands/eval.js";

describe("applyJudge — exitCode", () => {
  it("passes when exit matches", () => {
    const j: Judge = { type: "exitCode", equals: 0 };
    expect(applyJudge(undefined, "", 0, j).passed).toBe(true);
  });
  it("fails when exit differs", () => {
    const j: Judge = { type: "exitCode", equals: 0 };
    expect(applyJudge(undefined, "", 1, j).passed).toBe(false);
  });
});

describe("applyJudge — nonEmpty", () => {
  it("passes when raw output has content", () => {
    expect(applyJudge(null, "hello", 0, { type: "nonEmpty" }).passed).toBe(
      true,
    );
  });
  it("fails when raw output is empty whitespace", () => {
    expect(applyJudge(null, "   \n\n", 0, { type: "nonEmpty" }).passed).toBe(
      false,
    );
  });

  it("fails when an envelope carries an empty data result", () => {
    const parsed = { ok: true, data: [], next_actions: ["metadata"] };
    expect(
      applyJudge(parsed, JSON.stringify(parsed), 0, { type: "nonEmpty" })
        .passed,
    ).toBe(false);
  });
});

describe("applyJudge — effectStatus", () => {
  it("reads the operation effect verdict from the envelope", () => {
    const parsed = { meta: { effect_verdict: { status: "confirmed" } } };
    expect(
      applyJudge(parsed, JSON.stringify(parsed), 0, {
        type: "effectStatus",
        equals: "confirmed",
      }).passed,
    ).toBe(true);
  });
});

describe("applyJudge — matchesPattern", () => {
  it("passes when pattern matches", () => {
    const j: Judge = { type: "matchesPattern", pattern: "hello.*world" };
    expect(applyJudge(null, "hello cruel world", 0, j).passed).toBe(true);
  });
  it("fails when pattern misses", () => {
    const j: Judge = { type: "matchesPattern", pattern: "^xyz" };
    expect(applyJudge(null, "abc", 0, j).passed).toBe(false);
  });
});

describe("applyJudge — contains (raw + field)", () => {
  it("matches against raw output when no field", () => {
    expect(
      applyJudge(null, "hello", 0, { type: "contains", value: "ell" }).passed,
    ).toBe(true);
  });

  it("matches against a path inside parsed output", () => {
    const parsed = { data: [{ title: "great post" }] };
    const j: Judge = {
      type: "contains",
      field: "data[0].title",
      value: "great",
    };
    expect(applyJudge(parsed, JSON.stringify(parsed), 0, j).passed).toBe(true);
  });

  it("does not match envelope metadata when no field is declared", () => {
    const parsed = { data: [{ title: "post" }], next_actions: ["secret"] };
    expect(
      applyJudge(parsed, JSON.stringify(parsed), 0, {
        type: "contains",
        value: "secret",
      }).passed,
    ).toBe(false);
  });
});

describe("applyJudge — arrayMinLength", () => {
  it("passes when array is large enough", () => {
    expect(
      applyJudge([1, 2, 3], "[1,2,3]", 0, {
        type: "arrayMinLength",
        min: 2,
      }).passed,
    ).toBe(true);
  });

  it("fails when array is too short", () => {
    expect(
      applyJudge([1], "[1]", 0, { type: "arrayMinLength", min: 5 }).passed,
    ).toBe(false);
  });

  it("supports nested path", () => {
    const parsed = { data: { items: [1, 2, 3, 4] } };
    const j: Judge = { type: "arrayMinLength", path: "data.items", min: 3 };
    expect(applyJudge(parsed, JSON.stringify(parsed), 0, j).passed).toBe(true);
  });

  it("treats envelope data as the default result", () => {
    const parsed = { ok: true, data: [1, 2], error: null };
    expect(
      applyJudge(parsed, JSON.stringify(parsed), 0, {
        type: "arrayMinLength",
        min: 2,
      }).passed,
    ).toBe(true);
  });

  it("fails gracefully when path is not an array", () => {
    const parsed = { data: "not an array" };
    const j: Judge = { type: "arrayMinLength", path: "data", min: 1 };
    const r = applyJudge(parsed, JSON.stringify(parsed), 0, j);
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("not array");
  });
});

describe("loadEvalFile", () => {
  it("loads a well-formed YAML eval file", () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-evals-"));
    try {
      const file = join(dir, "fixture.yaml");
      writeFileSync(
        file,
        [
          "name: fixture",
          "adapter: hackernews",
          "cases:",
          "  - command: top",
          "    args:",
          "      limit: 1",
          "    judges:",
          "      - { type: arrayMinLength, min: 1 }",
        ].join("\n"),
      );
      const loaded = loadEvalFile(file);
      expect(loaded.name).toBe("fixture");
      expect(loaded.adapter).toBe("hackernews");
      expect(loaded.cases).toHaveLength(1);
      expect(loaded.cases[0].command).toBe("top");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a file missing required fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-evals-"));
    try {
      const file = join(dir, "bad.yaml");
      writeFileSync(file, "name: only-name\n");
      expect(() => loadEvalFile(file)).toThrow(/missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid evolution split metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-evals-"));
    try {
      const file = join(dir, "bad-split.yaml");
      writeFileSync(
        file,
        [
          "name: bad-split",
          "adapter: fixture",
          "cases:",
          "  - command: probe",
          "    split: heldout",
          "    judges:",
          "      - { type: exitCode, equals: 0 }",
        ].join("\n"),
      );
      expect(() => loadEvalFile(file)).toThrow(/split must be/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate case ids used by paired comparison", () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-evals-"));
    try {
      const file = join(dir, "duplicate-ids.yaml");
      writeFileSync(
        file,
        [
          "name: duplicate-ids",
          "adapter: fixture",
          "cases:",
          "  - id: repeated",
          "    command: probe",
          "    judges:",
          "      - { type: exitCode, equals: 0 }",
          "  - id: repeated",
          "    command: probe",
          "    judges:",
          "      - { type: exitCode, equals: 0 }",
        ].join("\n"),
      );
      expect(() => loadEvalFile(file)).toThrow(/case ids must be unique/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects cases without an executable verifier", () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-evals-"));
    try {
      const file = join(dir, "no-judge.yaml");
      writeFileSync(
        file,
        [
          "name: no-judge",
          "adapter: fixture",
          "cases:",
          "  - command: probe",
          "    judges: []",
        ].join("\n"),
      );
      expect(() => loadEvalFile(file)).toThrow(/at least one judge/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bundled eval files exist and parse", () => {
  it("loads every shipped eval file in evals/", async () => {
    const { discoverEvalFiles, loadEvalFile } =
      await import("../../src/commands/eval.js");
    const files = discoverEvalFiles();
    // Should have at least the 15 starter evals (smoke + regression).
    // We assert >= 15 to allow user-local evals to add more.
    expect(files.length).toBeGreaterThanOrEqual(15);
    for (const f of files) {
      // Throws on parse failure — that's the assertion.
      const parsed = loadEvalFile(f.path);
      expect(parsed.name).toBeTruthy();
      expect(parsed.adapter).toBeTruthy();
      expect(Array.isArray(parsed.cases)).toBe(true);
      expect(parsed.cases.length).toBeGreaterThan(0);
    }
  });
});
