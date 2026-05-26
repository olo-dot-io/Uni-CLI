import { describe, expect, it } from "vitest";

import { createPlatformComputeOverlayProvider } from "../../src/compute/platform-overlays.js";

describe("platform compute overlay provider selection", () => {
  it("selects one native HUD provider per supported desktop platform", () => {
    expect(
      createPlatformComputeOverlayProvider({ platform: "darwin" })?.provider,
    ).toBe("macos-appkit");
    expect(
      createPlatformComputeOverlayProvider({ platform: "win32" })?.provider,
    ).toBe("windows-win32");
    expect(
      createPlatformComputeOverlayProvider({ platform: "linux" })?.provider,
    ).toBe("linux-gtk");
  });

  it("returns no provider for platforms without a native desktop HUD", () => {
    expect(
      createPlatformComputeOverlayProvider({ platform: "freebsd" }),
    ).toBeUndefined();
  });
});
