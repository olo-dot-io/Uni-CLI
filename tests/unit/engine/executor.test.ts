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
import type { IPage } from "../../../src/types.js";
import { OperationOutcomeAmbiguousError } from "../../../src/transport/contained-process.js";

interface Capture {
  args?: Record<string, unknown>;
  source?: ArgSource;
  surface?: string;
  trace_id?: string;
}

let captured: Capture = {};
let cleanupFailure: Error | null = null;

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
  registerStep("__cleanup_probe__", (ctx: PipelineContext) => ({
    ...ctx,
    data: "cleanup-probe",
    page: {
      close: async () => {
        if (cleanupFailure) throw cleanupFailure;
      },
    } as unknown as IPage,
  }));
  registerStep("__execution_failure_probe__", () => {
    throw new Error("execution probe failed");
  });
  registerStep("__blocking_probe__", async (ctx, config) => {
    const probe = config as {
      started: () => void;
      wait: Promise<void>;
    };
    probe.started();
    await probe.wait;
    return ctx;
  });
  registerStep("__side_effect_probe__", (ctx, config) => {
    (config as { effect: () => void }).effect();
    return ctx;
  });
  registerStep("__settled_effect_probe__", (ctx, config) => {
    (config as { effect: () => void }).effect();
    return { ...ctx, data: { committed: true } };
  });
});

afterAll(() => {
  unregisterStep("__probe__");
  unregisterStep("__cleanup_probe__");
  unregisterStep("__execution_failure_probe__");
  unregisterStep("__blocking_probe__");
  unregisterStep("__side_effect_probe__");
  unregisterStep("__settled_effect_probe__");
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

  it("surfaces browser turn-finalization failures after successful work", async () => {
    cleanupFailure = new Error("turn finalization failed");
    try {
      await expect(
        runPipeline([{ __cleanup_probe__: {} }], {
          args: {},
          source: "internal",
        }),
      ).rejects.toThrow("turn finalization failed");
    } finally {
      cleanupFailure = null;
    }
  });

  it("retains both execution and turn-finalization failures", async () => {
    cleanupFailure = new Error("turn finalization failed");
    try {
      const failure = await runPipeline(
        [{ __cleanup_probe__: {} }, { __execution_failure_probe__: {} }],
        { args: {}, source: "internal" },
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([
        expect.objectContaining({
          message: expect.stringContaining("execution probe failed"),
        }),
        cleanupFailure,
      ]);
    } finally {
      cleanupFailure = null;
    }
  });

  it("cancels between actions before the next side effect can run", async () => {
    const controller = new AbortController();
    const cancellation = new Error("cancelled by MCP client");
    cancellation.name = "AbortError";
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let sideEffects = 0;

    const execution = runPipeline(
      [
        { __blocking_probe__: { started: markStarted, wait } },
        {
          __side_effect_probe__: {
            effect: () => {
              sideEffects += 1;
            },
          },
        },
      ],
      { args: {}, source: "mcp" },
      undefined,
      { signal: controller.signal, canMutate: false },
    );
    await started;
    controller.abort(cancellation);
    release();

    await expect(execution).rejects.toBe(cancellation);
    expect(sideEffects).toBe(0);
  });

  it("keeps an authoritative fulfillment when cancellation arrives inside the final mutating action", async () => {
    const controller = new AbortController();
    let effects = 0;

    const result = await runPipeline(
      [
        {
          __settled_effect_probe__: {
            effect: () => {
              effects += 1;
              controller.abort(
                new DOMException("late client cancellation", "AbortError"),
              );
            },
          },
        },
      ],
      { args: {}, source: "mcp" },
      undefined,
      { signal: controller.signal, canMutate: true },
    );

    expect(result).toEqual([{ committed: true }]);
    expect(effects).toBe(1);
  });

  it("marks a partially completed mutating pipeline ambiguous instead of running its next action", async () => {
    const controller = new AbortController();
    let committedEffects = 0;
    let laterEffects = 0;

    const execution = runPipeline(
      [
        {
          __settled_effect_probe__: {
            effect: () => {
              committedEffects += 1;
              controller.abort(
                new DOMException("cancel after first action", "AbortError"),
              );
            },
          },
        },
        {
          __side_effect_probe__: {
            effect: () => {
              laterEffects += 1;
            },
          },
        },
      ],
      { args: {}, source: "mcp" },
      undefined,
      { signal: controller.signal, canMutate: true },
    );

    await expect(execution).rejects.toBeInstanceOf(
      OperationOutcomeAmbiguousError,
    );
    expect(committedEffects).toBe(1);
    expect(laterEffects).toBe(0);
  });
});
