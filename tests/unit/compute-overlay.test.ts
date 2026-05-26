import { describe, expect, it } from "vitest";
import {
  attachComputeOverlayStatus,
  computeOverlayRequestFromAction,
  NOOP_COMPUTE_OVERLAY_PROVIDER,
} from "../../src/compute/overlay.js";
import { buildComputeActionVisualEvidence } from "../../src/compute/visual-timeline.js";

describe("compute overlay provider boundary", () => {
  it("turns visual action evidence into a provider-neutral overlay request", () => {
    const evidence = buildComputeActionVisualEvidence({
      tool: "computer-use.click",
      action: "compute_click",
      params: {
        ref: "@e7",
        bounds: { x: 10, y: 20, w: 100, h: 40 },
        pointerStart: { x: 12, y: 18 },
      },
      ok: true,
      transport: "desktop-ax",
    });

    const request = computeOverlayRequestFromAction(evidence.visual_action);

    expect(request).toMatchObject({
      action_id: evidence.visual_action.action_id,
      action: "compute_click",
      visual_style: "mac-glass-pointer-v1",
      state: "press",
      affordance: {
        cursor: "mac-pointer",
        halo: "pressure-bloom",
        click_ripple: true,
      },
      target: { x: 60, y: 40 },
    });
    expect(request?.samples).toHaveLength(16);
    expect(request?.samples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ x: 12, y: 18 }),
        expect.objectContaining({ x: 60, y: 40 }),
      ]),
    );
  });

  it("does not request a system HUD when the action has no visible target", () => {
    const evidence = buildComputeActionVisualEvidence({
      tool: "computer-use.find",
      action: "compute_find",
      params: { role: "button", name: "Save" },
      ok: false,
      transport: "visual",
    });

    expect(
      computeOverlayRequestFromAction(evidence.visual_action),
    ).toBeUndefined();
  });

  it("attaches provider acknowledgements without changing dispatch evidence", async () => {
    const evidence = buildComputeActionVisualEvidence({
      tool: "computer-use.click",
      action: "compute_click",
      params: {
        ref: "@e7",
        bounds: { x: 10, y: 20, w: 100, h: 40 },
        pointerStart: { x: 12, y: 18 },
      },
      ok: true,
      transport: "desktop-ax",
    });

    const withOverlay = await attachComputeOverlayStatus(
      evidence.visual_action,
      NOOP_COMPUTE_OVERLAY_PROVIDER,
    );

    expect(withOverlay.dispatch).toEqual(evidence.visual_action.dispatch);
    expect(withOverlay.overlay).toEqual({
      provider: "none",
      status: "not_requested",
    });
  });
});
