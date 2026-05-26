import { describe, expect, it } from "vitest";
import {
  buildCaptureVisualTimeline,
  buildComputeActionVisualEvidence,
  buildComputeActionVisualTimeline,
  validateComputeVisualAction,
} from "../../src/compute/visual-timeline.js";
import type { ComputeCapturePacket } from "../../src/compute/capture.js";

describe("compute visual timeline", () => {
  it("builds an ordered replay timeline from capture trajectory and image metadata", () => {
    const packet: Omit<ComputeCapturePacket, "visual_timeline"> = {
      schema_version: 1,
      captured_at: "2026-05-26T00:00:00.000Z",
      app: "Calculator",
      includes: ["snapshot", "screenshot"],
      snapshot: { ok: true, data: { text: '@e1 button "5"' } },
      screenshot: {
        ok: true,
        data: {
          path: "/tmp/calculator.png",
          image: {
            bytes: 10,
            sha256: "abc",
            width: 800,
            height: 600,
            coordinate_space: { kind: "image-pixels", origin: "top-left" },
          },
        },
      },
      trajectory: {
        replayable: true,
        steps: [
          {
            index: 0,
            action: "compute_snapshot",
            params: { app: "Calculator" },
            ok: true,
          },
          {
            index: 1,
            action: "compute_screenshot",
            params: { app: "Calculator" },
            ok: true,
          },
        ],
      },
    };

    const timeline = buildCaptureVisualTimeline(packet);

    expect(timeline).toMatchObject({
      schema_version: 1,
      replayable: true,
      subject: { app: "Calculator" },
      coordinate_space: { kind: "image-pixels", origin: "top-left" },
      theme: {
        name: "mac-glass-pointer-v1",
        prefers_reduced_motion: "collapse-durations",
      },
    });
    expect(timeline.events.map((event) => event.index)).toEqual([0, 1, 2, 3]);
    expect(timeline.events.map((event) => event.state)).toEqual([
      "observe",
      "wait",
      "target",
      "success",
    ]);
    expect(timeline.events.map((event) => event.at_ms)).toEqual([
      0, 240, 420, 620,
    ]);
    expect(timeline.events[2]).toMatchObject({
      action: "compute_screenshot",
      point: {
        x: 400,
        y: 300,
        coordinate_space: { kind: "image-pixels", origin: "top-left" },
      },
      affordance: { cursor: "mac-pointer", halo: "lift-shadow" },
    });
  });

  it("renders mutating actions as move, press, and terminal state events", () => {
    const timeline = buildComputeActionVisualTimeline({
      tool: "computer-use.click",
      action: "compute_click",
      params: {
        ref: "@e7",
        bounds: { x: 10, y: 20, w: 100, h: 40 },
      },
      ok: true,
      transport: "desktop-ax",
    });

    expect(timeline.events.map((event) => event.state)).toEqual([
      "move",
      "press",
      "success",
    ]);
    expect(timeline.events[0]).toMatchObject({
      ref: "@e7",
      point: {
        x: 60,
        y: 40,
        coordinate_space: { kind: "screen-pixels", origin: "top-left" },
      },
      affordance: { cursor: "mac-pointer", halo: "lift-shadow", trail: true },
    });
    expect(timeline.events[1]).toMatchObject({
      transition: "press",
      affordance: { click_ripple: true },
    });
    expect(timeline.events[2]).toMatchObject({
      ok: true,
      transport: "desktop-ax",
      transition: "fade",
    });
  });

  it("binds action targets, pointer motion, and dispatch coordinates into one evidence record", () => {
    const evidence = buildComputeActionVisualEvidence({
      tool: "computer-use.click",
      action: "compute_click",
      params: {
        ref: "@e7",
        bounds: { x: 10, y: 20, w: 100, h: 40 },
        pointerStart: { x: 12, y: 18 },
        screenIndex: 1,
      },
      ok: true,
      transport: "desktop-ax",
    });

    expect(evidence.visual_action).toMatchObject({
      schema_version: 2,
      tool: "computer-use.click",
      action: "compute_click",
      target: {
        ref: "@e7",
        point: {
          x: 60,
          y: 40,
          coordinate_space: {
            kind: "screen-pixels",
            origin: "top-left",
            screenIndex: 1,
          },
        },
      },
      dispatch: {
        status: "succeeded",
        transport: "desktop-ax",
        target: {
          x: 60,
          y: 40,
        },
      },
      overlay: {
        provider: "none",
        status: "not_requested",
      },
    });
    expect(evidence.visual_action.pointer_plan).toMatchObject({
      curve: "spring-bezier-v1",
      from: { x: 12, y: 18 },
      to: { x: 60, y: 40 },
      duration_ms: 240,
    });
    expect(evidence.visual_action.pointer_plan?.samples.at(-1)).toMatchObject({
      x: 60,
      y: 40,
    });
    expect(validateComputeVisualAction(evidence.visual_action)).toEqual([]);
  });

  it("rejects action evidence when replay and dispatch targets drift apart", () => {
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

    const invalid = {
      ...evidence.visual_action,
      dispatch: {
        ...evidence.visual_action.dispatch,
        target: {
          ...evidence.visual_action.dispatch.target!,
          x: 61,
        },
      },
    };

    expect(validateComputeVisualAction(invalid)).toEqual([
      "dispatch target must equal visual action target",
    ]);
  });

  it("represents wait actions with a restrained progress orbit", () => {
    const timeline = buildComputeActionVisualTimeline({
      tool: "computer-use.wait",
      action: "compute_wait",
      params: { text: "Ready", timeoutMs: 5000 },
      ok: false,
      transport: "desktop-ax",
    });

    expect(timeline.events.map((event) => event.state)).toEqual([
      "wait",
      "error",
    ]);
    expect(timeline.events[0]).toMatchObject({
      duration_ms: 500,
      affordance: { cursor: "mac-pointer", halo: "busy-orbit" },
    });
    expect(timeline.events[1]).toMatchObject({
      ok: false,
      transition: "snap",
      affordance: { halo: "error-shake" },
    });
  });
});
