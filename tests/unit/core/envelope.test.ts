/**
 * Envelope factory + helpers tests.
 *
 * The envelope is the unified error + data wrapper returned from every
 * TransportAdapter.action() call. It maps sysexits codes and carries the
 * fields that drive the self-repair loop (adapter_path, step, action,
 * suggestion, diff_candidate, minimum_capability, transport).
 */

import { describe, it, expect } from "vitest";
import {
  ok,
  err,
  exitCodeFor,
  EnvelopeExit,
} from "../../../src/core/envelope.js";

describe("envelope.ok", () => {
  it("wraps data with ok=true and no error field", () => {
    const e = ok({ count: 3 });
    expect(e.ok).toBe(true);
    expect(e.data).toEqual({ count: 3 });
    expect(e.error).toBeUndefined();
  });

  it("preserves generic data type in TS without widening to unknown", () => {
    const e = ok<{ msg: string }>({ msg: "hi" });
    // Type assertion via runtime check — TS inference covers rest.
    expect(e.data?.msg).toBe("hi");
  });

  it("carries elapsedMs when provided", () => {
    const e = ok({ a: 1 }, { elapsedMs: 42 });
    expect(e.elapsedMs).toBe(42);
  });
});

describe("envelope.err", () => {
  it("wraps error fields with ok=false and no data", () => {
    const e = err({
      transport: "http",
      step: 2,
      action: "fetch",
      reason: "HTTP 429",
      suggestion: "back off + retry",
    });
    expect(e.ok).toBe(false);
    expect(e.data).toBeUndefined();
    expect(e.error?.transport).toBe("http");
    expect(e.error?.step).toBe(2);
    expect(e.error?.action).toBe("fetch");
    expect(e.error?.reason).toBe("HTTP 429");
    expect(e.error?.suggestion).toBe("back off + retry");
    expect(e.error?.retryable).toBe(false); // default
  });

  it("propagates repair hints (adapter_path, diff_candidate, minimum_capability)", () => {
    const e = err({
      transport: "cdp-browser",
      step: 3,
      action: "click",
      reason: "selector missed",
      suggestion: "update selector for .btn",
      adapter_path: "adapters/x/y.yaml",
      diff_candidate: "- selector: .old\n+ selector: .new",
      minimum_capability: "cdp-browser.click",
      retryable: true,
    });
    expect(e.error?.adapter_path).toBe("adapters/x/y.yaml");
    expect(e.error?.diff_candidate).toContain("+ selector: .new");
    expect(e.error?.minimum_capability).toBe("cdp-browser.click");
    expect(e.error?.retryable).toBe(true);
  });

  it("defaults exit_code to GENERIC_ERROR when not supplied", () => {
    const e = err({
      transport: "http",
      step: 0,
      action: "fetch",
      reason: "x",
      suggestion: "y",
    });
    expect(e.error?.exit_code).toBe(EnvelopeExit.GENERIC_ERROR);
  });
});

describe("envelope.exitCodeFor", () => {
  it("maps reason tokens to sysexits codes", () => {
    expect(exitCodeFor("auth_required")).toBe(EnvelopeExit.AUTH_REQUIRED); // 77
    expect(exitCodeFor("config_error")).toBe(EnvelopeExit.CONFIG_ERROR); // 78
    expect(exitCodeFor("service_unavailable")).toBe(
      EnvelopeExit.SERVICE_UNAVAILABLE,
    ); // 69
    expect(exitCodeFor("temp_failure")).toBe(EnvelopeExit.TEMP_FAILURE); // 75
    expect(exitCodeFor("empty_result")).toBe(EnvelopeExit.EMPTY_RESULT); // 66
    expect(exitCodeFor("usage_error")).toBe(EnvelopeExit.USAGE_ERROR); // 2
  });

  it("falls back to GENERIC_ERROR on unknown reason", () => {
    expect(exitCodeFor("wat")).toBe(EnvelopeExit.GENERIC_ERROR); // 1
  });
});

describe("envelope sysexits constants", () => {
  it("match sysexits.h standard", () => {
    expect(EnvelopeExit.SUCCESS).toBe(0);
    expect(EnvelopeExit.GENERIC_ERROR).toBe(1);
    expect(EnvelopeExit.USAGE_ERROR).toBe(2);
    expect(EnvelopeExit.EMPTY_RESULT).toBe(66);
    expect(EnvelopeExit.SERVICE_UNAVAILABLE).toBe(69);
    expect(EnvelopeExit.TEMP_FAILURE).toBe(75);
    expect(EnvelopeExit.AUTH_REQUIRED).toBe(77);
    expect(EnvelopeExit.CONFIG_ERROR).toBe(78);
  });
});
