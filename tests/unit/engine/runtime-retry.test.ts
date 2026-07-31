import { describe, expect, it } from "vitest";

import type { PipelineContext } from "../../../src/engine/executor.js";
import { runWithRetry } from "../../../src/engine/runtime.js";

function context(canMutate: boolean): PipelineContext {
  return {
    data: null,
    args: {},
    vars: {},
    canMutate,
  };
}

describe("pipeline retry safety", () => {
  it("rejects retry on an intrinsically mutating POST before dispatch", async () => {
    await expect(
      runWithRetry(
        context(false),
        "fetch",
        { url: "https://example.test/mutate", method: "POST" },
        2,
        1,
        3,
        { fetch: {}, retry: 2 },
      ),
    ).rejects.toMatchObject({
      detail: {
        errorType: "config_error",
        step: 3,
        retryable: false,
        preserveErrorCode: true,
      },
    });
  });

  it("rejects retry when the owning command can mutate even if the step is GET", async () => {
    await expect(
      runWithRetry(
        context(true),
        "fetch",
        { url: "https://example.test/read", method: "GET" },
        1,
        1,
        0,
        { fetch: {}, retry: 1 },
      ),
    ).rejects.toMatchObject({
      detail: { errorType: "config_error", retryable: false },
    });
  });

  it("rejects retry for unknown/custom operators instead of guessing idempotency", async () => {
    await expect(
      runWithRetry(context(false), "custom_operator", {}, 1, 1, 0, {
        custom_operator: {},
        retry: 1,
      }),
    ).rejects.toMatchObject({
      detail: { errorType: "config_error", action: "custom_operator" },
    });
  });
});
