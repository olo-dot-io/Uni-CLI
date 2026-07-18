import { describe, expect, it } from "vitest";
import { localLoggingDisabledChildEnv } from "../../src/runtime/child-process-env.js";

describe("Uni-CLI child process logging environment", () => {
  it("sets both current and legacy opt-outs while preserving the parent environment", () => {
    expect(localLoggingDisabledChildEnv({ PATH: "/bin" })).toEqual({
      PATH: "/bin",
      UNICLI_NO_LOG: "1",
      UNICLI_NO_LEDGER: "1",
    });
  });
});
