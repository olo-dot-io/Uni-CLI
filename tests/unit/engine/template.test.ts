/**
 * template.test.ts — expression scope surface branching (MN3).
 *
 * Verifies that the kernel-plumbed `surface` / `trace_id` / `source`
 * fields reach YAML template expressions via `buildScope`. Branching
 * on `surface === "mcp"` is the canonical agent-style pattern —
 * adapters use it to emit `_meta` differently for MCP vs CLI calls.
 */

import { describe, it, expect } from "vitest";
import { evalExpression, evalTemplate } from "../../../src/engine/template.js";
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
