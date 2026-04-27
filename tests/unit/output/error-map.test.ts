import { describe, it, expect } from "vitest";
import {
  REF_LOCATOR_CODES,
  errorTypeToCode,
  mapErrorToExitCode,
  errorToAgentFields,
} from "../../../src/output/error-map.js";
import { PipelineError } from "../../../src/engine/executor.js";
import { BridgeConnectionError } from "../../../src/browser/bridge.js";
import { ExitCode } from "../../../src/types.js";

/**
 * Build a PipelineError with sensible defaults and any overrides merged in.
 * Keeps each test focused on the field under inspection.
 */
function makePipelineError(
  overrides: Partial<ConstructorParameters<typeof PipelineError>[1]> = {},
): PipelineError {
  return new PipelineError("pipeline failed", {
    step: 2,
    action: "fetch",
    config: { url: "https://example.com" },
    errorType: "http_error",
    suggestion: "Check URL",
    ...overrides,
  });
}

describe("REF_LOCATOR_CODES", () => {
  it("contains exactly the three T1 ref-locator codes", () => {
    expect(REF_LOCATOR_CODES.has("stale_ref")).toBe(true);
    expect(REF_LOCATOR_CODES.has("ambiguous")).toBe(true);
    expect(REF_LOCATOR_CODES.has("ref_not_found")).toBe(true);
    expect(REF_LOCATOR_CODES.size).toBe(3);
  });

  it("does not contain HTTP-404 not_found (distinct from ref_not_found)", () => {
    expect(REF_LOCATOR_CODES.has("not_found")).toBe(false);
  });
});

describe("errorTypeToCode — PipelineError branches", () => {
  it("maps statusCode 401 to auth_required", () => {
    const err = makePipelineError({ statusCode: 401 });
    expect(errorTypeToCode(err)).toBe("auth_required");
  });

  it("maps statusCode 403 to auth_required", () => {
    const err = makePipelineError({ statusCode: 403 });
    expect(errorTypeToCode(err)).toBe("auth_required");
  });

  it("maps missing cookie PipelineError to auth_required", () => {
    const err = new PipelineError(
      'No cookies found for "zhihu". Run: unicli auth setup zhihu',
      {
        step: -1,
        action: "auth",
        config: { site: "zhihu", strategy: "cookie" },
        errorType: "http_error",
        suggestion: "Run unicli auth setup zhihu",
      },
    );
    expect(errorTypeToCode(err)).toBe("auth_required");
    expect(mapErrorToExitCode(err)).toBe(ExitCode.AUTH_REQUIRED);
  });

  it("maps statusCode 404 to not_found", () => {
    const err = makePipelineError({ statusCode: 404 });
    expect(errorTypeToCode(err)).toBe("not_found");
  });

  it("maps statusCode 429 to rate_limited", () => {
    const err = makePipelineError({ statusCode: 429 });
    expect(errorTypeToCode(err)).toBe("rate_limited");
  });

  it("maps stale_ref errorType through verbatim", () => {
    const err = makePipelineError({ errorType: "stale_ref" });
    expect(errorTypeToCode(err)).toBe("stale_ref");
  });

  it("maps ambiguous errorType through verbatim", () => {
    const err = makePipelineError({ errorType: "ambiguous" });
    expect(errorTypeToCode(err)).toBe("ambiguous");
  });

  it("maps ref_not_found errorType through verbatim", () => {
    const err = makePipelineError({ errorType: "ref_not_found" });
    expect(errorTypeToCode(err)).toBe("ref_not_found");
  });

  it("maps selector_miss errorType to selector_miss", () => {
    const err = makePipelineError({ errorType: "selector_miss" });
    expect(errorTypeToCode(err)).toBe("selector_miss");
  });

  it("maps empty_result errorType to empty_result", () => {
    const err = makePipelineError({ errorType: "empty_result" });
    expect(errorTypeToCode(err)).toBe("empty_result");
  });

  it("maps timeout errorType to network_error", () => {
    const err = makePipelineError({ errorType: "timeout" });
    expect(errorTypeToCode(err)).toBe("network_error");
  });

  it("maps network_error errorType through directly", () => {
    const err = makePipelineError({ errorType: "network_error" });
    expect(errorTypeToCode(err)).toBe("network_error");
  });

  it("falls back to internal_error for unclassified PipelineError", () => {
    const err = makePipelineError({ errorType: "parse_error" });
    expect(errorTypeToCode(err)).toBe("internal_error");
  });
});

describe("errorTypeToCode — generic Error message matching", () => {
  it("maps ETIMEDOUT message to network_error", () => {
    expect(errorTypeToCode(new Error("connect ETIMEDOUT 1.2.3.4:443"))).toBe(
      "network_error",
    );
  });

  it("maps ECONNREFUSED message to network_error", () => {
    expect(errorTypeToCode(new Error("connect ECONNREFUSED 1.2.3.4:443"))).toBe(
      "network_error",
    );
  });

  it("maps socket hang up to network_error", () => {
    expect(errorTypeToCode(new Error("socket hang up"))).toBe("network_error");
  });

  it("maps 401/auth text to auth_required", () => {
    expect(errorTypeToCode(new Error("HTTP 401 Unauthorized"))).toBe(
      "auth_required",
    );
  });

  it("maps 404 text to not_found", () => {
    expect(errorTypeToCode(new Error("HTTP 404 Not Found"))).toBe("not_found");
  });

  it("maps rate-limit text to rate_limited", () => {
    expect(errorTypeToCode(new Error("429 rate-limited"))).toBe("rate_limited");
  });

  it("marks generic rate-limit errors as retryable", () => {
    const fields = errorToAgentFields(
      new Error("linux-do request failed: HTTP 429"),
      "src/adapters/linux-do/search.yaml",
      "linux-do",
    );
    expect(fields.retryable).toBe(true);
  });

  it("falls back to internal_error for unknown Error", () => {
    expect(errorTypeToCode(new Error("something exploded"))).toBe(
      "internal_error",
    );
  });

  it("handles non-Error unknowns (string) via String(err)", () => {
    expect(errorTypeToCode("plain string")).toBe("internal_error");
  });
});

describe("mapErrorToExitCode", () => {
  it("returns AUTH_REQUIRED for PipelineError with 401", () => {
    const err = makePipelineError({ statusCode: 401 });
    expect(mapErrorToExitCode(err)).toBe(ExitCode.AUTH_REQUIRED);
  });

  it("returns AUTH_REQUIRED for PipelineError with 403", () => {
    const err = makePipelineError({ statusCode: 403 });
    expect(mapErrorToExitCode(err)).toBe(ExitCode.AUTH_REQUIRED);
  });

  it("returns EMPTY_RESULT for PipelineError with empty_result errorType", () => {
    const err = makePipelineError({ errorType: "empty_result" });
    expect(mapErrorToExitCode(err)).toBe(ExitCode.EMPTY_RESULT);
  });

  it("returns TEMP_FAILURE for PipelineError with network_error errorType", () => {
    const err = makePipelineError({ errorType: "network_error" });
    expect(mapErrorToExitCode(err)).toBe(ExitCode.TEMP_FAILURE);
  });

  it("returns GENERIC_ERROR for other PipelineError", () => {
    const err = makePipelineError({ errorType: "parse_error" });
    expect(mapErrorToExitCode(err)).toBe(ExitCode.GENERIC_ERROR);
  });

  it("returns SERVICE_UNAVAILABLE for BridgeConnectionError", () => {
    const err = new BridgeConnectionError("bridge down");
    expect(mapErrorToExitCode(err)).toBe(ExitCode.SERVICE_UNAVAILABLE);
  });

  it("returns TEMP_FAILURE for transient network Errors", () => {
    expect(mapErrorToExitCode(new Error("connect ETIMEDOUT"))).toBe(
      ExitCode.TEMP_FAILURE,
    );
    expect(mapErrorToExitCode(new Error("daemon failed to start"))).toBe(
      ExitCode.TEMP_FAILURE,
    );
  });

  it("returns GENERIC_ERROR for unknown Error", () => {
    expect(mapErrorToExitCode(new Error("something else"))).toBe(
      ExitCode.GENERIC_ERROR,
    );
  });
});

describe("errorToAgentFields — PipelineError branch", () => {
  it("exposes adapter_path, step, and forwards detail fields verbatim", () => {
    const err = makePipelineError({
      step: 4,
      suggestion: "Re-snapshot and retry",
      retryable: true,
      alternatives: ["unicli repair foo bar"],
    });
    const fields = errorToAgentFields(err, "src/adapters/foo/bar.yaml", "foo");
    expect(fields).toEqual({
      adapter_path: "src/adapters/foo/bar.yaml",
      step: 4,
      suggestion: "Re-snapshot and retry",
      retryable: true,
      alternatives: ["unicli repair foo bar"],
    });
  });

  it("defaults retryable to false and alternatives to [] when detail omits them", () => {
    const err = makePipelineError({});
    const fields = errorToAgentFields(err, "src/adapters/foo/bar.yaml", "foo");
    expect(fields.retryable).toBe(false);
    expect(fields.alternatives).toEqual([]);
  });
});

describe("errorToAgentFields — BridgeConnectionError branch", () => {
  it("uses suggestion/retryable/alternatives from the instance; adapter_path/step are undefined", () => {
    const err = new BridgeConnectionError("bridge down");
    const fields = errorToAgentFields(err, "src/adapters/foo/bar.yaml", "foo");
    expect(fields).toEqual({
      adapter_path: undefined,
      step: undefined,
      suggestion: err.suggestion,
      retryable: err.retryable,
      alternatives: err.alternatives,
    });
  });
});

describe("errorToAgentFields — generic Error branch", () => {
  it("builds default suggestion with siteName and flags transient retryable=true", () => {
    const err = new Error("connect ETIMEDOUT 1.2.3.4:443");
    const fields = errorToAgentFields(err, "src/adapters/foo/bar.yaml", "foo");
    expect(fields.adapter_path).toBeUndefined();
    expect(fields.step).toBeUndefined();
    expect(fields.suggestion).toBe(
      "Run 'unicli test foo' to diagnose, or report this error.",
    );
    expect(fields.retryable).toBe(true);
    expect(fields.alternatives).toEqual([]);
  });

  it("marks non-transient Error as retryable=false", () => {
    const err = new Error("parse failed at line 12");
    const fields = errorToAgentFields(err, "src/adapters/foo/bar.yaml", "foo");
    expect(fields.retryable).toBe(false);
  });

  it("handles non-Error unknowns (string) via String(err)", () => {
    const fields = errorToAgentFields(
      "daemon failed hard",
      "src/adapters/foo/bar.yaml",
      "foo",
    );
    expect(fields.retryable).toBe(true); // matches "daemon failed"
    expect(fields.suggestion).toBe(
      "Run 'unicli test foo' to diagnose, or report this error.",
    );
  });
});
