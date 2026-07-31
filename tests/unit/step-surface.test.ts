import { describe, expect, it } from "vitest";

import {
  REGISTERED_STEP_BUDGET,
  TRANSPORT_NATIVE_STEP_BUDGET,
  getBuiltInStepSurface,
} from "../../src/engine/step-surface.js";
import { CAPABILITY_MATRIX } from "../../src/transport/capability.js";

describe("built-in action surface", () => {
  it("matches executable ownership to the capability matrix exactly", () => {
    const surface = getBuiltInStepSurface();
    expect(surface.totalCount).toBe(113);
    expect(surface.registeredCount).toBe(58);
    expect(surface.transportNativeCount).toBe(55);
    expect(surface.totalCount).toBe(
      surface.registeredCount + surface.transportNativeCount,
    );
    expect(surface.actions).toEqual(Object.keys(CAPABILITY_MATRIX).sort());
  });

  it("registers rate limiting and excludes sibling metadata or stale aliases", () => {
    const surface = getBuiltInStepSurface();
    expect(surface.registered).toContain("rate_limit");
    expect(surface.actions).toEqual(
      expect.arrayContaining([
        "oauth2-token",
        "select-xml",
        "split_text",
        "to_entries",
      ]),
    );
    expect(surface.actions).not.toContain("retry");
    expect(surface.actions).not.toContain("screenshot");
  });

  it("stays within the frozen registered and transport-native budgets", () => {
    const surface = getBuiltInStepSurface();
    expect(surface.registeredCount).toBeLessThanOrEqual(REGISTERED_STEP_BUDGET);
    expect(surface.transportNativeCount).toBeLessThanOrEqual(
      TRANSPORT_NATIVE_STEP_BUDGET,
    );
  });
});
