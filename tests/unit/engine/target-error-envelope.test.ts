/**
 * Executor integration for the ref-locator verification layer.
 *
 * Asserts that a TargetError thrown from a pipeline step is re-wrapped into a
 * PipelineError whose `errorType` preserves the original `TargetError.detail.code`
 * (stale_ref / ambiguous / not_found). This is the first half of the wire that
 * dispatch.ts then passes through to the v2 envelope's AgentError.code.
 */

import { afterEach, describe, expect, it } from "vitest";
import { PipelineError, runPipeline } from "../../../src/engine/executor.js";
import {
  registerStep,
  unregisterStep,
} from "../../../src/engine/step-registry.js";
import {
  ambiguous,
  notFound,
  staleRef,
  type TargetError,
} from "../../../src/browser/target-errors.js";

const STEP_NAME = "__target_error_probe__";

function register(err: TargetError): void {
  registerStep(STEP_NAME, () => {
    throw err;
  });
}

describe("executor integration — TargetError → PipelineError", () => {
  afterEach(() => {
    unregisterStep(STEP_NAME);
  });

  it("stale_ref preserves code as errorType and marks retryable", async () => {
    register(staleRef("12", 500, [{ ref: "7", role: "button", name: "Go" }]));
    try {
      await runPipeline(
        [{ [STEP_NAME]: {} } as never],
        {},
        undefined,
        undefined,
      );
      expect.unreachable("runPipeline should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineError);
      if (!(err instanceof PipelineError)) throw err;
      expect(err.detail.errorType).toBe("stale_ref");
      expect(err.detail.retryable).toBe(true);
      expect(err.detail.suggestion).toMatch(/snapshot/i);
      expect(err.detail.alternatives).toContain("ref:7 (button: Go)");
    }
  });

  it("ambiguous preserves code as errorType and is non-retryable", async () => {
    register(
      ambiguous("3", [
        { ref: "3", role: "button", name: "Submit" },
        { ref: "4", role: "button", name: "Submit" },
      ]),
    );
    try {
      await runPipeline(
        [{ [STEP_NAME]: {} } as never],
        {},
        undefined,
        undefined,
      );
      expect.unreachable("runPipeline should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineError);
      if (!(err instanceof PipelineError)) throw err;
      expect(err.detail.errorType).toBe("ambiguous");
      expect(err.detail.retryable).toBe(false);
      expect(err.detail.suggestion).toMatch(/narrow the ref/i);
      expect(err.detail.alternatives).toHaveLength(2);
    }
  });

  it("not_found preserves code as errorType and is non-retryable", async () => {
    register(notFound("9"));
    try {
      await runPipeline(
        [{ [STEP_NAME]: {} } as never],
        {},
        undefined,
        undefined,
      );
      expect.unreachable("runPipeline should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineError);
      if (!(err instanceof PipelineError)) throw err;
      expect(err.detail.errorType).toBe("not_found");
      expect(err.detail.retryable).toBe(false);
      expect(err.detail.suggestion).toMatch(/not on the page/i);
      expect(err.detail.alternatives).toEqual([]);
    }
  });

  it("alternatives list is capped at 5 entries", async () => {
    const cands = Array.from({ length: 8 }, (_, i) => ({
      ref: String(i + 1),
      role: "button",
      name: `Btn${String(i + 1)}`,
    }));
    register(ambiguous("1", cands));
    try {
      await runPipeline(
        [{ [STEP_NAME]: {} } as never],
        {},
        undefined,
        undefined,
      );
      expect.unreachable("runPipeline should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineError);
      if (!(err instanceof PipelineError)) throw err;
      expect(err.detail.alternatives).toHaveLength(5);
    }
  });
});
