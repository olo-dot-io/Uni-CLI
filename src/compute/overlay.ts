/**
 * @owner   src/compute/overlay.ts
 * @does    Define the provider boundary for system-level compute HUD rendering.
 * @needs   src/compute/visual-timeline.ts visual action evidence
 * @feeds   macOS AppKit overlay provider, MCP computer-use evidence
 * @breaks  Mixing HUD rendering with action dispatch can make evidence lie about what actually ran.
 * @invariants Overlay providers may only acknowledge rendering; transports remain the action executors.
 * @side-effects provider-dependent rendering only
 * @perf    O(pointer samples) per render request
 * @concurrency providers serialize their own native process or window state
 * @test    tests/unit/compute-overlay.test.ts
 * @stability experimental
 * @since   0.224.0
 */

import type {
  ComputeVisualAction,
  ComputeVisualAffordance,
  ComputeVisualCursorPoint,
  ComputeCursorState,
  ComputeVisualOverlayStatus,
  ComputeVisualPointerSample,
} from "./visual-timeline.js";
import { COMPUTE_CURSOR_STYLE_ID } from "./cursor-visual-style.js";

export interface ComputeOverlaySample {
  at_ms: number;
  x: number;
  y: number;
  screenIndex?: number;
}

export interface ComputeOverlayRequest {
  action_id: string;
  action: string;
  visual_style: typeof COMPUTE_CURSOR_STYLE_ID;
  state: ComputeCursorState;
  affordance: ComputeVisualAffordance;
  target: ComputeOverlaySample;
  duration_ms: number;
  samples: ComputeOverlaySample[];
}

export interface ComputeOverlayProvider {
  readonly provider: ComputeVisualOverlayStatus["provider"];
  currentPoint?(): ComputeVisualCursorPoint | undefined;
  render(action: ComputeVisualAction): Promise<ComputeVisualOverlayStatus>;
  close?(): Promise<void>;
}

export const NOOP_COMPUTE_OVERLAY_PROVIDER: ComputeOverlayProvider = {
  provider: "none",
  async render() {
    return {
      provider: "none",
      status: "not_requested",
    };
  },
};

export function computeOverlayRequestFromAction(
  action: ComputeVisualAction,
): ComputeOverlayRequest | undefined {
  const target = action.target?.point;
  if (!target) return undefined;
  const samples = action.pointer_plan?.samples.length
    ? action.pointer_plan.samples.map(sampleFromPointerSample)
    : [sampleFromPoint(target, 0)];
  return {
    action_id: action.action_id,
    action: action.action,
    visual_style: COMPUTE_CURSOR_STYLE_ID,
    ...overlayAffordanceFromAction(action.action),
    target: sampleFromPoint(target, action.pointer_plan?.duration_ms ?? 0),
    duration_ms: action.pointer_plan?.duration_ms ?? 120,
    samples,
  };
}

function overlayAffordanceFromAction(action: string): {
  state: ComputeCursorState;
  affordance: ComputeVisualAffordance;
} {
  switch (action) {
    case "compute_click":
      return {
        state: "press",
        affordance: {
          cursor: "mac-pointer",
          halo: "pressure-bloom",
          click_ripple: true,
        },
      };
    case "compute_wait":
      return {
        state: "wait",
        affordance: { cursor: "mac-pointer", halo: "busy-orbit" },
      };
    case "compute_type":
      return {
        state: "type",
        affordance: { cursor: "mac-pointer", halo: "pressure-bloom" },
      };
    case "compute_scroll":
      return {
        state: "scroll",
        affordance: { cursor: "mac-pointer", halo: "lift-shadow", trail: true },
      };
    case "compute_screenshot":
    case "compute_snapshot":
    case "compute_capture":
    case "compute_find":
    case "compute_observe":
    case "compute_assert":
      return {
        state: "observe",
        affordance: { cursor: "mac-pointer", halo: "lift-shadow" },
      };
    default:
      return {
        state: "target",
        affordance: { cursor: "mac-pointer", halo: "lift-shadow" },
      };
  }
}

export async function attachComputeOverlayStatus(
  action: ComputeVisualAction,
  provider: ComputeOverlayProvider,
): Promise<ComputeVisualAction> {
  return {
    ...action,
    overlay: await provider.render(action),
  };
}

function sampleFromPointerSample(
  sample: ComputeVisualPointerSample,
): ComputeOverlaySample {
  return {
    at_ms: sample.at_ms,
    x: sample.x,
    y: sample.y,
    ...(sample.coordinate_space.screenIndex !== undefined
      ? { screenIndex: sample.coordinate_space.screenIndex }
      : {}),
  };
}

function sampleFromPoint(
  point: ComputeVisualCursorPoint,
  atMs: number,
): ComputeOverlaySample {
  return {
    at_ms: atMs,
    x: point.x,
    y: point.y,
    ...(point.coordinate_space.screenIndex !== undefined
      ? { screenIndex: point.coordinate_space.screenIndex }
      : {}),
  };
}
