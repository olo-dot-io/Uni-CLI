import { describe, expect, it } from "vitest";

import { PipelineError, runPipeline } from "../../../src/engine/executor.js";
import type { StepObservation } from "../../../src/engine/step-observer.js";
import type { PipelineStep } from "../../../src/types.js";
import type { ResolvedArgs } from "../../../src/engine/args.js";

// `set` is a registered, network-free step: it writes to ctx.vars and leaves
// ctx.data untouched (null at pipeline start), so each `set` step yields a
// deterministic "ok" observation with output {kind:"empty"}. Output-shape
// classification itself is proven by step-observer.test.ts; these tests prove
// the executor WIRING (one observation per step, correct metadata, error path,
// observer isolation).
function bag(args: Record<string, unknown> = {}): ResolvedArgs {
  return { args, source: "test" as ResolvedArgs["source"] };
}

function collector(): {
  seen: StepObservation[];
  record: (o: StepObservation) => void;
} {
  const seen: StepObservation[] = [];
  return { seen, record: (o) => seen.push(o) };
}

describe("runPipeline step observation — auditability side channel", () => {
  it("emits one ok observation per executed step with index, action, timing", async () => {
    const steps: PipelineStep[] = [{ set: { a: 1 } }, { set: { b: 2 } }];
    const obs = collector();

    await runPipeline(steps, bag(), undefined, { observer: obs });

    expect(obs.seen).toHaveLength(2);
    expect(obs.seen[0]).toMatchObject({
      index: 0,
      action: "set",
      status: "ok",
    });
    expect(obs.seen[1]).toMatchObject({
      index: 1,
      action: "set",
      status: "ok",
    });
    for (const o of obs.seen) {
      expect(o.status).toBe("ok");
      expect(o.output).toBeDefined();
      expect(typeof o.durationMs).toBe("number");
      expect(o.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("throws a typed unknown_action PipelineError for an unregistered step", async () => {
    const steps: PipelineStep[] = [
      { totally_unknown_step: {} } as PipelineStep,
    ];
    let caught: unknown;
    try {
      await runPipeline(steps, bag());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PipelineError);
    const pe = caught as PipelineError;
    expect(pe.detail.errorType).toBe("unknown_action");
    expect(pe.detail.step).toBe(0);
    expect(pe.detail.action).toBe("totally_unknown_step");
    expect(pe.detail.retryable).toBe(false);
  });

  it("emits an error observation carrying errorType and message before throwing", async () => {
    const steps: PipelineStep[] = [{ nope_not_a_step: {} } as PipelineStep];
    const obs = collector();
    await expect(
      runPipeline(steps, bag(), undefined, { observer: obs }),
    ).rejects.toBeInstanceOf(PipelineError);

    expect(obs.seen).toHaveLength(1);
    expect(obs.seen[0]).toMatchObject({
      index: 0,
      action: "nope_not_a_step",
      status: "error",
      errorType: "unknown_action",
    });
    expect(obs.seen[0]?.errorMessage).toContain("nope_not_a_step");
  });

  it("runs normally with no observer (zero-overhead default)", async () => {
    const steps: PipelineStep[] = [{ set: { a: 1 } }];
    await expect(runPipeline(steps, bag())).resolves.toBeDefined();
  });

  it("a throwing observer never breaks the run (side-channel isolation)", async () => {
    const steps: PipelineStep[] = [{ set: { a: 1 } }];
    await expect(
      runPipeline(steps, bag(), undefined, {
        observer: {
          record: () => {
            throw new Error("observer is broken");
          },
        },
      }),
    ).resolves.toBeDefined();
  });
});
