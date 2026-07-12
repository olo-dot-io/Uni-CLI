import { describe, expect, it } from "vitest";
import { runColdStart } from "../../bench/cold-start.js";

describe("cold-start benchmark", () => {
  it("parses the full JSON list envelope", () => {
    const result = runColdStart(1);

    expect(result.sites).toBeGreaterThan(0);
    expect(result.commands).toBeGreaterThan(0);
    expect(result.version_wall_ms_p50).toBeGreaterThan(0);
    expect(result.help_wall_ms_p50).toBeGreaterThan(0);
    expect(result.version_wall_ms_p50).toBeLessThan(result.wall_ms_p50);
    expect(result.help_wall_ms_p50).toBeLessThan(result.wall_ms_p50);
  });
});
