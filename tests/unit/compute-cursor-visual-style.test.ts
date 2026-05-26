import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { COMPUTE_CURSOR_VISUAL_STYLE } from "../../src/compute/cursor-visual-style.js";
import { buildLinuxOverlayPythonScript } from "../../src/compute/linux-overlay.js";
import {
  buildMacosOverlayDaemonSwiftScript,
  buildMacosOverlaySwiftScript,
} from "../../src/compute/macos-overlay.js";
import { buildWindowsOverlayPowerShellScript } from "../../src/compute/windows-overlay.js";

const repoRoot = join(import.meta.dirname, "..", "..");

describe("compute cursor visual style", () => {
  it("defines the rewritten cursor as a skinned Mac-style pointer with a real hotspot", () => {
    expect(COMPUTE_CURSOR_VISUAL_STYLE).toMatchObject({
      id: "mac-glass-pointer-v1",
      cursor: "mac-pointer",
      motion: "hotspot-spring-path",
      hotspot: { x: 0, y: 0 },
      states: ["observe", "move", "press", "wait", "success", "error"],
    });
    expect(COMPUTE_CURSOR_VISUAL_STYLE.bannedTerms).toEqual(
      expect.arrayContaining([
        "unicli-neon-glass",
        "aqua-ring",
        "aperture-reticle-v1",
        "reticle",
        "compute-cursor-fill",
        "conic-gradient",
      ]),
    );
  });

  it("renders the docs demo as an arrow pointer skin instead of a circle HUD", () => {
    const component = readFileSync(
      join(repoRoot, "docs/.vitepress/theme/components/ComputeCursorDemo.vue"),
      "utf8",
    );

    expect(component).toContain("mac-glass-pointer-v1");
    expect(component).toContain("cursor-arrow");
    expect(component).toContain("cursor-arrow-fill");
    expect(component).toContain("cursor-arrow-outline");
    expect(component).toContain("cursor-hotspot");
    expect(component).toContain("cursor-pressure");
    expect(component).not.toContain("cursor-aperture");
    expect(component).not.toContain("cursor-brackets");
    expect(component).not.toContain("compute-cursor-fill");
    expect(component).not.toContain("pointer-trail");
    expect(component).not.toContain("conic-gradient");
  });

  it("rewrites every native provider around pointer-skin primitives", () => {
    const macos = [
      buildMacosOverlaySwiftScript(),
      buildMacosOverlayDaemonSwiftScript(),
    ].join("\n");
    const windows = buildWindowsOverlayPowerShellScript();
    const linux = buildLinuxOverlayPythonScript();

    for (const source of [macos, windows, linux]) {
      expect(source).toContain("mac-glass-pointer-v1");
      expect(source).toContain("mac-pointer");
      expect(source).toContain("hotspot");
      expect(source).toContain("pointerPath");
      expect(source).toContain("click_ripple");
      expect(source).toContain("pressure");
      expect(source).toContain("busy-orbit");
      expect(source).toContain("0.78");
      expect(source).not.toContain("reticle.addEllipse");
      expect(source).not.toContain("calibratedRed: 0.33, green: 0.88");
      expect(source).not.toContain("FromArgb(82, 84, 224, 255)");
      expect(source).not.toContain("set_source_rgba(0.33, 0.88, 1.0");
    }
  });
});
