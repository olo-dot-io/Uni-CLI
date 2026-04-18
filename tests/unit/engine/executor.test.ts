/**
 * executor.test.ts — runPipeline(ResolvedArgs bag) signature tests.
 *
 * v0.213.3 P3 (D6) migrated runPipeline from `(steps, args, base, opts)` to
 * `(steps, bag: ResolvedArgs, base, opts)`. These tests assert the bag
 * seeds `ctx.args` / `ctx.source` and that surface/trace_id flow from
 * PipelineOptions into templates.
 *
 * We register a synthetic `__probe__` step so the test can inspect the
 * PipelineContext directly without depending on fetch/map/select semantics.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  runPipeline,
  type PipelineContext,
} from "../../../src/engine/executor.js";
import {
  registerStep,
  unregisterStep,
} from "../../../src/engine/step-registry.js";

interface Capture {
  args?: Record<string, unknown>;
  source?: string;
  surface?: string;
  trace_id?: string;
}

let captured: Capture = {};

beforeAll(() => {
  registerStep("__probe__", (ctx: PipelineContext) => {
    captured = {
      args: ctx.args,
      source: ctx.source,
      surface: ctx.surface,
      trace_id: ctx.trace_id,
    };
    return { ...ctx, data: ctx.args };
  });
});

afterAll(() => {
  unregisterStep("__probe__");
});

describe("runPipeline — ResolvedArgs bag plumbing", () => {
  it("ctx.args === bag.args (by reference)", async () => {
    const bagArgs = { name: "agent-42", count: 7 };
    await runPipeline([{ __probe__: {} }], {
      args: bagArgs,
      source: "internal",
    });
    expect(captured.args).toBe(bagArgs);
  });

  it("ctx.source === bag.source", async () => {
    await runPipeline([{ __probe__: {} }], { args: {}, source: "mcp" });
    expect(captured.source).toBe("mcp");
  });

  it("ctx.surface and ctx.trace_id come from PipelineOptions", async () => {
    await runPipeline(
      [{ __probe__: {} }],
      { args: {}, source: "cli" },
      undefined,
      { surface: "cli", trace_id: "01HZXYZABCDE" },
    );
    expect(captured.surface).toBe("cli");
    expect(captured.trace_id).toBe("01HZXYZABCDE");
  });

  it("surface/trace_id undefined when caller omits options", async () => {
    captured = {};
    await runPipeline([{ __probe__: {} }], { args: {}, source: "internal" });
    expect(captured.surface).toBeUndefined();
    expect(captured.trace_id).toBeUndefined();
  });

  it("new 'internal' ArgSource is accepted", async () => {
    await runPipeline([{ __probe__: {} }], {
      args: { probe: true },
      source: "internal",
    });
    expect(captured.source).toBe("internal");
    expect(captured.args).toEqual({ probe: true });
  });
});
