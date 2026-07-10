import { describe, it, expect } from "vitest";

import {
  annotateAuthRetryFailure,
  shouldRefreshAuthError,
} from "../../../src/output/auth-guidance.js";
import type { AgentError, AgentContext } from "../../../src/output/envelope.js";

function ctx(error?: AgentError): AgentContext {
  return { command: "x.search", duration_ms: 0, ...(error ? { error } : {}) };
}

describe("annotateAuthRetryFailure — single source of the --auth-retry failure annotation", () => {
  it("refreshes both ordinary auth failures and browser challenges", () => {
    expect(shouldRefreshAuthError("auth_required")).toBe(true);
    expect(shouldRefreshAuthError("challenge_required")).toBe(true);
    expect(shouldRefreshAuthError("permission_denied")).toBe(false);
    expect(shouldRefreshAuthError(undefined)).toBe(false);
  });

  it("merges the refresh suggestion, attaches an import remedy, mirrors onto the envelope", () => {
    const error: AgentError = {
      code: "auth_required",
      message: "login required",
      suggestion: "sign in first",
    };
    const result = { error, envelope: ctx(error) };

    annotateAuthRetryFailure(result, "open Chrome and log in", "twitter");

    expect(result.error.suggestion).toBe(
      "sign in first open Chrome and log in",
    );
    expect(result.error.remedy).toEqual({
      message: "open Chrome and log in",
      command: "unicli auth import twitter",
    });
    expect(result.envelope.error).toBe(result.error);
  });

  it("falls back to a generic remedy message when refresh gave no suggestion", () => {
    const error: AgentError = { code: "auth_required", message: "nope" };
    const result = { error, envelope: ctx(error) };

    annotateAuthRetryFailure(result, undefined, "bilibili");

    expect(result.error.remedy?.message).toBe(
      "Refresh browser login state, then retry.",
    );
    expect(result.error.remedy?.command).toBe("unicli auth import bilibili");
    // suggestion with no prior + no refresh collapses to empty string
    expect(result.error.suggestion).toBe("");
  });

  it("is a no-op when there is no error to annotate", () => {
    const result: { error?: AgentError; envelope: AgentContext } = {
      envelope: ctx(),
    };
    annotateAuthRetryFailure(result, "anything", "x");
    expect(result.error).toBeUndefined();
  });
});
