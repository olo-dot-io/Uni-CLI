/**
 * template.test.ts — expression scope surface branching (MN3).
 *
 * Verifies that the kernel-plumbed `surface` / `trace_id` / `source`
 * fields reach YAML template expressions via `buildScope`. Branching
 * on `surface === "mcp"` is the canonical agent-style pattern —
 * adapters use it to emit `_meta` differently for MCP vs CLI calls.
 */

import { describe, it, expect } from "vitest";
import { evalTemplate } from "../../../src/engine/template.js";
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
