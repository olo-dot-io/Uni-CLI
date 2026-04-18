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
import type { ArgSource, ResolvedArgs } from "../../../src/engine/args.js";

interface Capture {
  args?: Record<string, unknown>;
  source?: ArgSource;
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
    const bag: ResolvedArgs = { args: bagArgs, source: "internal" };
    await runPipeline([{ __probe__: {} }], bag);
    expect(captured.args).toBe(bagArgs);
  });

  it("ctx.source === bag.source", async () => {
    const bag: ResolvedArgs = { args: {}, source: "mcp" };
    await runPipeline([{ __probe__: {} }], bag);
    expect(captured.source).toBe("mcp");
  });

  it("ctx.surface and ctx.trace_id come from PipelineOptions", async () => {
    // MN1 — previous revision used `source: "cli"` which is NOT a member
    // of the ArgSource union. `ResolvedArgs`-typed bag now catches that
    // drift at compile time.
    const bag: ResolvedArgs = { args: {}, source: "internal" };
    await runPipeline([{ __probe__: {} }], bag, undefined, {
      surface: "cli",
      trace_id: "01HZXYZABCDE",
    });
    expect(captured.surface).toBe("cli");
    expect(captured.trace_id).toBe("01HZXYZABCDE");
  });

  it("surface/trace_id undefined when caller omits options", async () => {
    captured = {};
    const bag: ResolvedArgs = { args: {}, source: "internal" };
    await runPipeline([{ __probe__: {} }], bag);
    expect(captured.surface).toBeUndefined();
    expect(captured.trace_id).toBeUndefined();
  });

  it("new 'internal' ArgSource is accepted", async () => {
    const bag: ResolvedArgs = { args: { probe: true }, source: "internal" };
    await runPipeline([{ __probe__: {} }], bag);
    expect(captured.source).toBe("internal");
    expect(captured.args).toEqual({ probe: true });
  });
});
