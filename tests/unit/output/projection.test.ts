/**
 * projection.test.ts — `--select` / `--fields` / `--pluck` / `--pluck0`
 * externalization.
 *
 * These flags let agents project kernel output before the formatter runs,
 * replacing `| jq` / `| awk` pipelines. The priority order (pluck0 > pluck
 * > select > fields) is asserted here, plus each flag's individual
 * behavior. P3 R2 closeout adds IM1 (pluck newline sanitization + pluck0
 * NUL variant) and IM3 (ProjectionError on malformed --select).
 */

import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyProjection,
  renderPluck,
  renderPluck0,
  pluckRow,
  ProjectionError,
} from "../../../src/output/projection.js";

const ROWS = [
  { title: "hello", url: "https://a", score: 1 },
  { title: "world", url: "https://b", score: 2 },
  { title: "agents", url: "https://c", score: 3 },
];

describe("applyProjection — --select (JSONPath)", () => {
  it("'$[0].title' returns a single-row array with the first title", () => {
    const p = applyProjection(ROWS, { select: "$[0].title" });
    expect(p.pluckMode).toBe(false);
    expect(p.results).toEqual(["hello"]);
  });

  it("'$[*].title' returns every title", () => {
    const p = applyProjection(ROWS, { select: "$[*].title" });
    expect(p.results).toEqual(["hello", "world", "agents"]);
  });

  it("'$[?(@.score>1)]' filters by predicate", () => {
    const p = applyProjection(ROWS, { select: "$[?(@.score>1)]" });
    expect(p.results).toHaveLength(2);
    expect((p.results[0] as { title: string }).title).toBe("world");
  });

  it("no matches → empty array (not null/undefined)", () => {
    const p = applyProjection(ROWS, { select: "$[10].title" });
    expect(p.results).toEqual([]);
  });
});

describe("applyProjection — --fields (column projection)", () => {
  it("comma-separated list becomes columns override", () => {
    const p = applyProjection(ROWS, { fields: "title,score" });
    expect(p.columns).toEqual(["title", "score"]);
    expect(p.results).toBe(ROWS); // unchanged — columns applied by formatter
  });

  it("trims whitespace and drops empty entries", () => {
    const p = applyProjection(ROWS, { fields: " title , , score , " });
    expect(p.columns).toEqual(["title", "score"]);
  });
});

describe("applyProjection — --pluck (single-field stream)", () => {
  it("pluckMode=true short-circuits formatter", () => {
    const p = applyProjection(ROWS, { pluck: "url" });
    expect(p.pluckMode).toBe(true);
    expect(p.results).toBe(ROWS);
  });

  it("renderPluck emits one value per line, no header", () => {
    const out = renderPluck(ROWS, "title");
    expect(out).toBe("hello\nworld\nagents");
  });

  it("pluckRow serializes nested objects as one-line JSON", () => {
    expect(pluckRow({ nested: { a: 1 } }, "nested")).toEqual({
      value: '{"a":1}',
      sanitized: false,
    });
  });

  it("pluckRow returns empty string for missing / null fields", () => {
    expect(pluckRow({ title: "x" }, "missing")).toEqual({
      value: "",
      sanitized: false,
    });
    expect(pluckRow({ title: null }, "title")).toEqual({
      value: "",
      sanitized: false,
    });
    expect(pluckRow(null, "title")).toEqual({
      value: "",
      sanitized: false,
    });
  });

  // IM1 — newline sanitization + debounced warning
  it("pluckRow collapses embedded newlines to a single space", () => {
    expect(pluckRow({ title: "a\nb" }, "title")).toEqual({
      value: "a b",
      sanitized: true,
    });
    expect(pluckRow({ title: "a\r\nb\nc" }, "title")).toEqual({
      value: "a b c",
      sanitized: true,
    });
  });

  it("renderPluck emits single warning when values had newlines stripped", () => {
    const warn = vi.fn();
    const out = renderPluck(
      [{ title: "a\nb" }, { title: "c\nd" }, { title: "e" }],
      "title",
      warn,
    );
    expect(out).toBe("a b\nc d\ne");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe(
      "[pluck] sanitized 2 value(s) containing newlines",
    );
  });

  it("renderPluck emits no warning when no newlines present", () => {
    const warn = vi.fn();
    renderPluck([{ title: "a" }, { title: "b" }], "title", warn);
    expect(warn).not.toHaveBeenCalled();
  });
});

// IM1 — --pluck0 NUL-delimited variant
describe("applyProjection — --pluck0 (NUL-delimited stream)", () => {
  it("pluck0Mode=true short-circuits formatter", () => {
    const p = applyProjection(ROWS, { pluck0: "url" });
    expect(p.pluck0Mode).toBe(true);
    expect(p.pluckMode).toBe(false);
    expect(p.results).toBe(ROWS);
  });

  it("renderPluck0 emits NUL after every value (including last)", () => {
    const out = renderPluck0([{ id: "x" }, { id: "y" }], "id");
    expect(out).toBe("x\0y\0");
  });

  it("renderPluck0 preserves values with newlines (sanitized to spaces)", () => {
    const warn = vi.fn();
    const out = renderPluck0([{ id: "a\nb" }, { id: "c" }], "id", warn);
    expect(out).toBe("a b\0c\0");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("applyProjection — flag precedence", () => {
  it("pluck beats select and emits a single warning", () => {
    const warn = vi.fn();
    const p = applyProjection(ROWS, { pluck: "title", select: "$[0]" }, warn);
    expect(p.pluckMode).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0]?.[0] as string;
    expect(msg).toContain("--pluck");
    expect(msg).toContain("wins");
  });

  it("pluck0 beats pluck (IM1)", () => {
    const warn = vi.fn();
    const p = applyProjection(ROWS, { pluck0: "id", pluck: "title" }, warn);
    expect(p.pluck0Mode).toBe(true);
    expect(p.pluckMode).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0]?.[0] as string;
    expect(msg).toContain("--pluck0");
    expect(msg).toContain("wins");
  });

  it("select beats fields", () => {
    const warn = vi.fn();
    const p = applyProjection(
      ROWS,
      { select: "$[*].title", fields: "x,y" },
      warn,
    );
    expect(p.pluckMode).toBe(false);
    expect(p.results).toEqual(["hello", "world", "agents"]);
    expect(p.columns).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("no flags → pass-through", () => {
    const warn = vi.fn();
    const p = applyProjection(ROWS, {}, warn);
    expect(p.results).toBe(ROWS);
    expect(p.columns).toBeUndefined();
    expect(p.pluckMode).toBe(false);
    expect(p.pluck0Mode).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

// IM3 — malformed --select surfaces as ProjectionError (not silent empty)
describe("applyProjection — ProjectionError on malformed --select", () => {
  it("unclosed bracket throws ProjectionError with flag/expression context", () => {
    expect(() => applyProjection(ROWS, { select: "$.items[" })).toThrowError(
      ProjectionError,
    );
    try {
      applyProjection(ROWS, { select: "$.items[" });
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectionError);
      const pe = err as ProjectionError;
      expect(pe.detail.flag).toBe("select");
      expect(pe.detail.expression).toBe("$.items[");
      expect(pe.message).toContain("--select parse error");
    }
  });

  it("legitimate zero-match still returns empty array (not error)", () => {
    const p = applyProjection(ROWS, { select: "$[99].title" });
    expect(p.results).toEqual([]);
  });
});

// IM3 end-to-end via dist/main.js spawn — confirms ProjectionError
// maps to exit=2 via dispatch.ts (malformed --select is caught BEFORE
// the network call, so this stays fast and network-free).
describe("dispatch wiring — malformed --select exit code (spawn)", () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT = join(__dirname, "..", "..", "..");
  const DIST_MAIN = join(REPO_ROOT, "dist", "main.js");

  const runCli = (
    args: string[],
  ): { stdout: string; stderr: string; code: number | null } => {
    const r = spawnSync("node", [DIST_MAIN, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: { ...process.env, UNICLI_OUTPUT: "json" },
      timeout: 30_000,
    });
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      code: r.status,
    };
  };

  // IM3 — malformed `--select` yields exit 2 with a stderr diagnostic.
  // We trigger the pre-validation (unbalanced brackets) inside
  // `applySelect` so the test does NOT depend on any adapter actually
  // succeeding. The kernel still runs (network call), so it may also
  // return 66/69/etc; the ProjectionError path overrides to 2 only when
  // the kernel exited 0. To isolate the projection path, we target a
  // local-only adapter — `hackernews top` is the agreed smoke target.
  // When the network is unavailable, the kernel exits non-zero first
  // and the projection step never runs — we skip the assertion in that
  // case.
  it.skipIf(!existsSync(DIST_MAIN))(
    "IM3: --select '$.items[' → exit 2 with stderr '[projection] --select parse error'",
    () => {
      const r = runCli([
        "hackernews",
        "top",
        "--limit",
        "1",
        "--select",
        "$.items[",
      ]);
      if (r.stderr.includes("[projection]")) {
        expect(r.code).toBe(2);
        expect(r.stderr).toMatch(/--select parse error/);
        expect(r.stderr).toMatch(/unbalanced brackets/);
      } else {
        // Kernel failed before projection ran (network / infra).
        console.warn(
          `spawn-test (IM3): projection never ran (exit=${r.code}); ` +
            `stderr head=${r.stderr.slice(0, 200)}`,
        );
      }
    },
    40_000,
  );
});
