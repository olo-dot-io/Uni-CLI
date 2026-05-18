/**
 * template.test.ts — expression scope surface branching (MN3).
 *
 * Verifies that the kernel-plumbed `surface` / `trace_id` / `source`
 * fields reach YAML template expressions via `buildScope`. Branching
 * on `surface === "mcp"` is the canonical agent-style pattern —
 * adapters use it to emit `_meta` differently for MCP vs CLI calls.
 */

import { describe, it, expect } from "vitest";
import {
  evalExpression,
  evalTemplate,
  TemplateEvalError,
} from "../../../src/engine/template.js";
import type { PipelineContext } from "../../../src/engine/executor.js";

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    data: null,
    args: {},
    vars: {},
    ...overrides,
  };
}

describe("evalTemplate — surface scope branching", () => {
  it("ternary on surface evaluates against ctx.surface", () => {
    const ctxMcp = makeCtx({ surface: "mcp" });
    const out = evalTemplate(`\${{ surface === "mcp" ? "x" : "y" }}`, ctxMcp);
    expect(out).toBe("x");

    const ctxCli = makeCtx({ surface: "cli" });
    expect(evalTemplate(`\${{ surface === "mcp" ? "x" : "y" }}`, ctxCli)).toBe(
      "y",
    );
  });

  it("trace_id is visible to templates (agent-author warning: reaches outgoing URLs)", () => {
    const ctx = makeCtx({ trace_id: "01HZXYZABCDE" });
    expect(evalTemplate("${{ trace_id }}", ctx)).toBe("01HZXYZABCDE");
  });

  it("source is visible to templates", () => {
    const ctx = makeCtx({ source: "stdin" });
    expect(evalTemplate("${{ source }}", ctx)).toBe("stdin");
  });

  it("env.X resolves to process.env.X for credential templating", () => {
    const ctx = makeCtx();
    const key = "UNICLI_TEMPLATE_ENV_TEST_KEY_8473";
    const value = "secret-token-fixture";
    process.env[key] = value;
    try {
      expect(evalTemplate(`\${{ env.${key} }}`, ctx)).toBe(value);
      expect(evalTemplate(`\${{ env.${key} || 'fallback' }}`, ctx)).toBe(value);
    } finally {
      delete process.env[key];
    }
  });

  it("env.X falls back via || when the variable is unset (adapter idiom)", () => {
    const ctx = makeCtx();
    const key = "UNICLI_TEMPLATE_ENV_UNSET_KEY_8473";
    delete process.env[key];
    expect(evalTemplate(`\${{ env.${key} || 'absent' }}`, ctx)).toBe("absent");
  });
});

describe("evalExpression — || logical-OR is not split as a pipe filter", () => {
  it("`a || b` returns the first truthy operand and ignores phantom filters", () => {
    expect(evalExpression("a || b", { a: 0, b: "fallback" })).toBe("fallback");
    expect(evalExpression("a || b", { a: "first", b: "fallback" })).toBe(
      "first",
    );
  });

  it("filter expression with || mirrors adapter pattern (homebrew/openrouter)", () => {
    const items = [
      { name: "JQ", desc: "json query" },
      { name: "ripgrep", desc: "search tool" },
      { name: "GoJQ", desc: "" },
    ];
    const expr =
      "item.name.toLowerCase().includes(args.query.toLowerCase()) || (item.desc || '').toLowerCase().includes(args.query.toLowerCase())";
    const args = { query: "jq" };
    const matched = items.filter((item) =>
      Boolean(evalExpression(expr, { item, args })),
    );
    expect(matched.map((i) => i.name)).toEqual(["JQ", "GoJQ"]);
  });

  it("genuine pipe after a `||` chain still applies", () => {
    expect(
      evalExpression("a || b || c | uppercase", { a: "", b: "", c: "ok" }),
    ).toBe("OK");
  });
});

describe("evalExpression — unknown filter surfaces TemplateEvalError", () => {
  it("throws on a single unknown filter (fast-path)", () => {
    expect(() =>
      evalExpression("item.title | nosuchfilter", { item: { title: "x" } }),
    ).toThrowError(TemplateEvalError);
  });

  it("throws on an unknown filter after a valid one (slow-path)", () => {
    expect(() =>
      evalExpression("(a + b) | uppercase | nope", { a: "x", b: "y" }),
    ).toThrowError(/unknown filter: nope/);
  });

  it("includes the offending filter name on the error", () => {
    try {
      evalExpression("item.title | bogus", { item: { title: "x" } });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateEvalError);
      expect((err as TemplateEvalError).message).toContain("bogus");
      expect((err as TemplateEvalError).expr).toBe("item.title | bogus");
    }
  });

  it("VM-side undefined access stays lenient (no throw)", () => {
    // Adapter authors widely rely on `item.author.nickname` not crashing
    // when author is null; the VM throws TypeError, our catch surfaces it
    // as `undefined` so evalTemplate can stringify to an empty cell.
    const result = evalExpression("item.author.nickname", {
      item: { author: null },
    });
    expect(result).toBeUndefined();
  });
});

describe("evalExpression — date_iso pipe filter", () => {
  it("converts Unix epoch in seconds to ISO-8601", () => {
    expect(
      evalExpression("item.t | date_iso", { item: { t: 1777950000 } }),
    ).toBe(new Date(1777950000 * 1000).toISOString());
  });

  it("converts Unix epoch in milliseconds to ISO-8601", () => {
    expect(
      evalExpression("item.t | date_iso", { item: { t: 1777950000000 } }),
    ).toBe(new Date(1777950000000).toISOString());
  });

  it("returns empty string for null / NaN / zero / negative input", () => {
    expect(evalExpression("item.t | date_iso", { item: { t: null } })).toBe("");
    expect(evalExpression("item.t | date_iso", { item: { t: "abc" } })).toBe(
      "",
    );
    expect(evalExpression("item.t | date_iso", { item: { t: 0 } })).toBe("");
    expect(evalExpression("item.t | date_iso", { item: { t: -5 } })).toBe("");
  });
});
