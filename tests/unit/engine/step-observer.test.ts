import { describe, expect, it } from "vitest";

import {
  summarizeOutput,
  type StepObservation,
  type StepObserver,
} from "../../../src/engine/step-observer.js";

describe("summarizeOutput — leak-free shape classification", () => {
  it("reports null and undefined as empty", () => {
    expect(summarizeOutput(null)).toEqual({ kind: "empty" });
    expect(summarizeOutput(undefined)).toEqual({ kind: "empty" });
  });

  it("reports array kind with length as size", () => {
    expect(summarizeOutput([])).toEqual({ kind: "array", size: 0 });
    expect(summarizeOutput([1, 2, 3])).toEqual({ kind: "array", size: 3 });
  });

  it("reports string kind with character length as size", () => {
    expect(summarizeOutput("")).toEqual({ kind: "string", size: 0 });
    expect(summarizeOutput("abc")).toEqual({ kind: "string", size: 3 });
  });

  it("reports object kind with key count as size", () => {
    expect(summarizeOutput({})).toEqual({ kind: "object", size: 0 });
    expect(summarizeOutput({ a: 1, b: 2 })).toEqual({
      kind: "object",
      size: 2,
    });
  });

  it("reports scalar kinds without a size", () => {
    expect(summarizeOutput(42)).toEqual({ kind: "number" });
    expect(summarizeOutput(0)).toEqual({ kind: "number" });
    expect(summarizeOutput(10n)).toEqual({ kind: "number" });
    expect(summarizeOutput(true)).toEqual({ kind: "boolean" });
    expect(summarizeOutput(false)).toEqual({ kind: "boolean" });
  });

  it("never leaks the raw value — summary carries only kind and size", () => {
    const secret = { token: "s3cr3t", cookies: ["a", "b"] };
    const summary = summarizeOutput(secret);
    expect(JSON.stringify(summary)).not.toContain("s3cr3t");
    expect(summary).toEqual({ kind: "object", size: 2 });
  });
});

describe("StepObserver contract", () => {
  it("a collecting observer captures observations in order", () => {
    const seen: StepObservation[] = [];
    const observer: StepObserver = {
      record: (o) => seen.push(o),
    };
    observer.record({
      index: 0,
      action: "fetch",
      status: "ok",
      durationMs: 12,
      output: { kind: "object", size: 3 },
    });
    observer.record({
      index: 1,
      action: "select",
      status: "error",
      durationMs: 4,
      errorType: "selector_miss",
      errorMessage: "no match",
    });
    expect(seen.map((o) => [o.index, o.action, o.status])).toEqual([
      [0, "fetch", "ok"],
      [1, "select", "error"],
    ]);
  });
});
