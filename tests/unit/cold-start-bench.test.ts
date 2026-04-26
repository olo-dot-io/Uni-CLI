import { describe, expect, it } from "vitest";
import { runColdStart } from "../../bench/cold-start.js";

describe("cold-start benchmark", () => {
  it("parses the full JSON list envelope", () => {
    const result = runColdStart(1);

    expect(result.sites).toBeGreaterThan(0);
    expect(result.commands).toBeGreaterThan(0);
  });
});
