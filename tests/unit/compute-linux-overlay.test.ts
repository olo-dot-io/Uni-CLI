import { describe, expect, it } from "vitest";

import {
  buildLinuxOverlayPythonScript,
  LinuxGtkOverlayDaemonProvider,
} from "../../src/compute/linux-overlay.js";
import { buildComputeActionVisualEvidence } from "../../src/compute/visual-timeline.js";

describe("Linux GTK compute overlay", () => {
  it("builds a click-through all-monitor GTK/Cairo HUD daemon", () => {
    const source = buildLinuxOverlayPythonScript();

    expect(source).toContain('gi.require_version("Gtk", "3.0")');
    expect(source).toContain("set_keep_above(True)");
    expect(source).toContain("input_shape_combine_region");
    expect(source).toContain('"status":"ready"');
    expect(source).toContain("for line in sys.stdin");
  });

  it("renders through the shared overlay request and retains virtual pointer state", async () => {
    const evidence = buildComputeActionVisualEvidence({
      tool: "computer-use.scroll",
      action: "compute_scroll",
      params: { x: 320, y: 180, pointerStart: { x: 20, y: 30 } },
      ok: true,
      transport: "desktop-atspi",
    });
    const requests: Array<{ target: { x: number; y: number } }> = [];
    const provider = new LinuxGtkOverlayDaemonProvider({
      platform: "linux",
      sessionFactory: async () => ({
        async render(request) {
          requests.push(request);
          return {
            provider: "linux-gtk",
            status: "arrived",
            acknowledged_at_ms: request.duration_ms,
          };
        },
        async close() {},
      }),
    });

    const status = await provider.render(evidence.visual_action);

    expect(status).toMatchObject({
      provider: "linux-gtk",
      status: "arrived",
    });
    expect(requests[0]).toMatchObject({
      action: "compute_scroll",
      visual_style: "mac-glass-pointer-v1",
      state: "scroll",
      affordance: {
        cursor: "mac-pointer",
        halo: "lift-shadow",
        trail: true,
      },
      target: { x: 320, y: 180 },
    });
    expect(provider.currentPoint()).toMatchObject({ x: 320, y: 180 });
  });
});
