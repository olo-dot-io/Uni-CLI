import { describe, expect, it } from "vitest";

import { isRequestedModelActive } from "../../src/adapters/_electron/shared.js";

describe("Electron AI chat shared helpers", () => {
  it("verifies model switches from the observed current model text", () => {
    expect(isRequestedModelActive("GPT-4o", "gpt-4o")).toBe(true);
    expect(isRequestedModelActive("Current model: GPT-4o mini", "gpt-4o")).toBe(
      true,
    );
    expect(isRequestedModelActive("Claude Sonnet 4.5", "gpt-4o")).toBe(false);
    expect(isRequestedModelActive("unknown", "gpt-4o")).toBe(false);
    expect(isRequestedModelActive("GPT-4o", "")).toBe(false);
  });
});
