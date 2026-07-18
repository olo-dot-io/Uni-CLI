/**
 * @owner   src/compute/visual-timeline.ts
 * @does    Convert compute capture and action evidence into ordered visual cursor timelines and action records.
 * @needs   src/compute/capture.ts types, src/compute/cursor-visual-style.ts
 * @feeds   compute capture packets, computer-use MCP evidence, docs cursor replay demo
 * @breaks  Missing, unordered, or drifting evidence makes computer-use frontends misleading.
 * @invariants Timeline events replay UI affordances; visual_action binds target, pointer motion, overlay, and dispatch evidence.
 * @side-effects none
 * @perf    O(number of timeline events); no image bytes are copied.
 * @concurrency pure functions
 * @test    tests/unit/compute-visual-timeline.test.ts, tests/unit/commands/compute.test.ts
 * @stability beta
 * @since   0.224.0
 */

import type { ComputeCapturePacket } from "./capture.js";
import { COMPUTE_CURSOR_STYLE_ID } from "./cursor-visual-style.js";

export type ComputeCursorState =
  | "idle"
  | "observe"
  | "move"
  | "target"
  | "press"
  | "type"
  | "scroll"
  | "wait"
  | "success"
  | "error";

export type ComputeCursorGlyph = "mac-pointer";

export type ComputeCursorHalo =
  | "none"
  | "lift-shadow"
  | "pressure-bloom"
  | "busy-orbit"
  | "success-spark"
  | "error-shake";

export type ComputeCursorTransition =
  | "settle"
  | "glide"
  | "pulse"
  | "press"
  | "spin"
  | "snap"
  | "fade"
  | "scan";

export interface ComputeVisualCoordinateSpace {
  kind: "screen-pixels" | "image-pixels";
  origin: "top-left";
  screenIndex?: number;
  width?: number;
  height?: number;
}

export interface ComputeVisualCursorPoint {
  x: number;
  y: number;
  coordinate_space: ComputeVisualCoordinateSpace;
}

export interface ComputeVisualAffordance {
  cursor: ComputeCursorGlyph;
  halo: ComputeCursorHalo;
  trail?: boolean;
  click_ripple?: boolean;
}

export interface ComputeVisualTimelineEvent {
  index: number;
  at_ms: number;
  duration_ms: number;
  state: ComputeCursorState;
  label: string;
  action: string;
  transition: ComputeCursorTransition;
  affordance: ComputeVisualAffordance;
  ok?: boolean;
  transport?: string;
  ref?: string;
  point?: ComputeVisualCursorPoint;
}

export interface ComputeVisualTimeline {
  schema_version: 1;
  replayable: true;
  subject?: {
    app?: string;
    tool?: string;
  };
  coordinate_space?: ComputeVisualCoordinateSpace;
  theme: {
    name: typeof COMPUTE_CURSOR_STYLE_ID;
    prefers_reduced_motion: "collapse-durations";
  };
  events: ComputeVisualTimelineEvent[];
}

export interface ComputeActionTimelineInput {
  tool: string;
  action: string;
  params?: Record<string, unknown>;
  ok: boolean;
  transport?: string;
}

export type ComputeVisualActionStatus = "succeeded" | "failed";

export interface ComputeVisualActionTarget {
  ref?: string;
  point?: ComputeVisualCursorPoint;
}

export interface ComputeVisualPointerSample {
  at_ms: number;
  x: number;
  y: number;
  coordinate_space: ComputeVisualCoordinateSpace;
}

export interface ComputeVisualPointerPlan {
  curve: "spring-bezier-v1";
  duration_ms: number;
  from: ComputeVisualCursorPoint;
  to: ComputeVisualCursorPoint;
  samples: ComputeVisualPointerSample[];
}

export interface ComputeVisualOverlayStatus {
  provider: "none" | "macos-appkit" | "windows-win32" | "linux-gtk";
  status:
    | "not_requested"
    | "unavailable"
    | "scheduled"
    | "arrived"
    | "timeout"
    | "failed";
  acknowledged_at_ms?: number;
  error?: string;
}

export interface ComputeVisualActionDispatch {
  status: ComputeVisualActionStatus;
  transport?: string;
  target?: ComputeVisualCursorPoint;
}

export interface ComputeVisualActionPostCapture {
  ok: boolean;
  transport?: string;
  data?: unknown;
  error?: {
    reason: string;
    minimum_capability?: string;
    exit_code?: number;
  };
}

export interface ComputeVisualAction {
  schema_version: 2;
  action_id: string;
  tool: string;
  action: string;
  target?: ComputeVisualActionTarget;
  pointer_plan?: ComputeVisualPointerPlan;
  overlay: ComputeVisualOverlayStatus;
  dispatch: ComputeVisualActionDispatch;
  post_capture?: ComputeVisualActionPostCapture;
}

export interface ComputeActionVisualEvidence {
  visual_timeline: ComputeVisualTimeline;
  visual_action: ComputeVisualAction;
}

const THEME: ComputeVisualTimeline["theme"] = {
  name: COMPUTE_CURSOR_STYLE_ID,
  prefers_reduced_motion: "collapse-durations",
};

export function buildCaptureVisualTimeline(
  packet: Omit<ComputeCapturePacket, "visual_timeline">,
): ComputeVisualTimeline {
  const screenshotSpace = screenshotCoordinateSpace(packet);
  const screenshotPoint = screenshotSpace
    ? {
        x: Math.round(Math.max(0, (screenshotSpace.width ?? 1) - 1) / 2),
        y: Math.round(Math.max(0, (screenshotSpace.height ?? 1) - 1) / 2),
        coordinate_space: screenshotSpace,
      }
    : undefined;
  const events: ComputeVisualTimelineEvent[] = [];
  let atMs = 0;

  for (const step of packet.trajectory.steps) {
    if (step.action === "compute_snapshot") {
      events.push({
        index: events.length,
        at_ms: atMs,
        duration_ms: 240,
        state: "observe",
        label: "snapshot",
        action: step.action,
        transition: "scan",
        ok: step.ok,
        affordance: { cursor: "mac-pointer", halo: "lift-shadow" },
      });
      atMs += 240;
      if (packet.trajectory.steps.length > step.index + 1) {
        events.push({
          index: events.length,
          at_ms: atMs,
          duration_ms: 180,
          state: "wait",
          label: "stabilize",
          action: "compute_capture.wait_for_pixels",
          transition: "spin",
          affordance: { cursor: "mac-pointer", halo: "busy-orbit" },
        });
        atMs += 180;
      }
      continue;
    }

    events.push({
      index: events.length,
      at_ms: atMs,
      duration_ms: 200,
      state: "target",
      label: "screenshot",
      action: step.action,
      transition: "pulse",
      ok: step.ok,
      ...(screenshotPoint ? { point: screenshotPoint } : {}),
      affordance: { cursor: "mac-pointer", halo: "lift-shadow" },
    });
    atMs += 200;
  }

  const ok = events.every((event) => event.ok !== false);
  events.push({
    index: events.length,
    at_ms: atMs,
    duration_ms: 140,
    state: ok ? "success" : "error",
    label: ok ? "captured" : "capture failed",
    action: "compute_capture",
    transition: ok ? "fade" : "snap",
    ok,
    affordance: {
      cursor: "mac-pointer",
      halo: ok ? "success-spark" : "error-shake",
    },
  });

  return {
    schema_version: 1,
    replayable: true,
    ...(packet.app ? { subject: { app: packet.app } } : {}),
    ...(screenshotSpace ? { coordinate_space: screenshotSpace } : {}),
    theme: THEME,
    events,
  };
}

export function buildComputeActionVisualTimeline(
  input: ComputeActionTimelineInput,
): ComputeVisualTimeline {
  const params = input.params ?? {};
  const ref = typeof params.ref === "string" ? params.ref : undefined;
  const point = pointFromParams(params);
  const events: ComputeVisualTimelineEvent[] = [];
  let atMs = 0;

  const push = (
    event: Omit<ComputeVisualTimelineEvent, "index" | "at_ms">,
  ): void => {
    events.push({
      index: events.length,
      at_ms: atMs,
      ...event,
    });
    atMs += event.duration_ms;
  };

  switch (input.action) {
    case "compute_click":
      push({
        duration_ms: 180,
        state: "move",
        label: "move",
        action: input.action,
        transition: "glide",
        ...(ref ? { ref } : {}),
        ...(point ? { point } : {}),
        affordance: { cursor: "mac-pointer", halo: "lift-shadow", trail: true },
      });
      push({
        duration_ms: 120,
        state: "press",
        label: "press",
        action: input.action,
        transition: "press",
        ...(ref ? { ref } : {}),
        ...(point ? { point } : {}),
        affordance: {
          cursor: "mac-pointer",
          halo: "pressure-bloom",
          click_ripple: true,
        },
      });
      break;
    case "compute_type":
      push({
        duration_ms: 180,
        state: "target",
        label: "focus target",
        action: input.action,
        transition: "glide",
        ...(ref ? { ref } : {}),
        ...(point ? { point } : {}),
        affordance: { cursor: "mac-pointer", halo: "lift-shadow", trail: true },
      });
      push({
        duration_ms: 220,
        state: "type",
        label: "type",
        action: input.action,
        transition: "pulse",
        ...(ref ? { ref } : {}),
        ...(point ? { point } : {}),
        affordance: { cursor: "mac-pointer", halo: "pressure-bloom" },
      });
      break;
    case "compute_scroll":
      push({
        duration_ms: 260,
        state: "scroll",
        label: "scroll",
        action: input.action,
        transition: "glide",
        ...(ref ? { ref } : {}),
        ...(point ? { point } : {}),
        affordance: { cursor: "mac-pointer", halo: "lift-shadow", trail: true },
      });
      break;
    case "compute_wait":
      push({
        duration_ms: 500,
        state: "wait",
        label: "wait",
        action: input.action,
        transition: "spin",
        ...(ref ? { ref } : {}),
        ...(point ? { point } : {}),
        affordance: { cursor: "mac-pointer", halo: "busy-orbit" },
      });
      break;
    case "compute_screenshot":
    case "compute_snapshot":
    case "compute_capture":
    case "compute_find":
    case "compute_observe":
    case "compute_assert":
      push({
        duration_ms: 220,
        state: "observe",
        label: "observe",
        action: input.action,
        transition: "scan",
        ...(ref ? { ref } : {}),
        ...(point ? { point } : {}),
        affordance: { cursor: "mac-pointer", halo: "lift-shadow" },
      });
      break;
    default:
      push({
        duration_ms: 220,
        state: "target",
        label: "action",
        action: input.action,
        transition: "settle",
        ...(ref ? { ref } : {}),
        ...(point ? { point } : {}),
        affordance: { cursor: "mac-pointer", halo: "lift-shadow" },
      });
  }

  push({
    duration_ms: 140,
    state: input.ok ? "success" : "error",
    label: input.ok ? "done" : "failed",
    action: input.action,
    transition: input.ok ? "fade" : "snap",
    ok: input.ok,
    ...(input.transport ? { transport: input.transport } : {}),
    ...(ref ? { ref } : {}),
    ...(point ? { point } : {}),
    affordance: {
      cursor: "mac-pointer",
      halo: input.ok ? "success-spark" : "error-shake",
    },
  });

  return {
    schema_version: 1,
    replayable: true,
    subject: { tool: input.tool },
    ...(point ? { coordinate_space: point.coordinate_space } : {}),
    theme: THEME,
    events,
  };
}

export function buildComputeActionVisualEvidence(
  input: ComputeActionTimelineInput,
): ComputeActionVisualEvidence {
  const params = input.params ?? {};
  const ref = typeof params.ref === "string" ? params.ref : undefined;
  const point = pointFromParams(params);
  const pointerStart = point
    ? pointerStartFromParams(params, point)
    : undefined;
  const pointerPlan =
    point && pointerStart
      ? buildSpringBezierPointerPlan(pointerStart, point)
      : undefined;
  const target =
    ref || point
      ? {
          ...(ref ? { ref } : {}),
          ...(point ? { point } : {}),
        }
      : undefined;

  return {
    visual_timeline: buildComputeActionVisualTimeline(input),
    visual_action: {
      schema_version: 2,
      action_id: computeActionId(input.tool, input.action, target),
      tool: input.tool,
      action: input.action,
      ...(target ? { target } : {}),
      ...(pointerPlan ? { pointer_plan: pointerPlan } : {}),
      overlay: {
        provider: "none",
        status: "not_requested",
      },
      dispatch: {
        status: input.ok ? "succeeded" : "failed",
        ...(input.transport ? { transport: input.transport } : {}),
        ...(point ? { target: point } : {}),
      },
    },
  };
}

export function validateComputeVisualAction(
  action: ComputeVisualAction,
): string[] {
  const problems: string[] = [];
  const targetPoint = action.target?.point;
  const dispatchTarget = action.dispatch.target;
  const pointerPlan = action.pointer_plan;

  if (
    targetPoint &&
    dispatchTarget &&
    !samePoint(targetPoint, dispatchTarget)
  ) {
    problems.push("dispatch target must equal visual action target");
  }

  if (targetPoint && pointerPlan && !samePoint(pointerPlan.to, targetPoint)) {
    problems.push("pointer plan destination must equal visual action target");
  }

  const lastSample = pointerPlan?.samples.at(-1);
  if (
    targetPoint &&
    pointerPlan &&
    lastSample &&
    !samePoint(lastSample, targetPoint)
  ) {
    problems.push("pointer plan must end at visual action target");
  }

  return problems;
}

function screenshotCoordinateSpace(
  packet: Omit<ComputeCapturePacket, "visual_timeline">,
): ComputeVisualCoordinateSpace | undefined {
  const image = readImageMetadata(packet.screenshot?.data);
  if (!image) return undefined;
  return {
    kind: "image-pixels",
    origin: "top-left",
    ...(image.width ? { width: image.width } : {}),
    ...(image.height ? { height: image.height } : {}),
  };
}

function readImageMetadata(
  data: unknown,
): { width?: number; height?: number } | undefined {
  if (!isRecord(data) || !isRecord(data.image)) return undefined;
  return {
    ...(typeof data.image.width === "number"
      ? { width: data.image.width }
      : {}),
    ...(typeof data.image.height === "number"
      ? { height: data.image.height }
      : {}),
  };
}

function pointFromParams(
  params: Record<string, unknown>,
): ComputeVisualCursorPoint | undefined {
  const bounds = readBounds(params.bounds);
  if (bounds) {
    return {
      x: Math.round(bounds.x + bounds.w / 2),
      y: Math.round(bounds.y + bounds.h / 2),
      coordinate_space: {
        kind: "screen-pixels",
        origin: "top-left",
        ...(typeof params.screenIndex === "number"
          ? { screenIndex: params.screenIndex }
          : {}),
      },
    };
  }
  if (typeof params.x === "number" && typeof params.y === "number") {
    return {
      x: params.x,
      y: params.y,
      coordinate_space: {
        kind: "screen-pixels",
        origin: "top-left",
        ...(typeof params.screenIndex === "number"
          ? { screenIndex: params.screenIndex }
          : {}),
      },
    };
  }
  return undefined;
}

function pointerStartFromParams(
  params: Record<string, unknown>,
  target: ComputeVisualCursorPoint,
): ComputeVisualCursorPoint | undefined {
  if (!isRecord(params.pointerStart)) return undefined;
  const x = readNumber(params.pointerStart.x);
  const y = readNumber(params.pointerStart.y);
  if (x === undefined || y === undefined) return undefined;
  return {
    x,
    y,
    coordinate_space: target.coordinate_space,
  };
}

function buildSpringBezierPointerPlan(
  from: ComputeVisualCursorPoint,
  to: ComputeVisualCursorPoint,
): ComputeVisualPointerPlan {
  const durationMs = 240;
  const sampleCount = 16;
  const samples: ComputeVisualPointerSample[] = [];

  for (let index = 0; index < sampleCount; index += 1) {
    const progress = index / (sampleCount - 1);
    const eased = smoothSpring(progress);
    samples.push({
      at_ms: Math.round(progress * durationMs),
      x: roundedLerp(from.x, to.x, eased),
      y: roundedLerp(from.y, to.y, eased),
      coordinate_space: to.coordinate_space,
    });
  }

  return {
    curve: "spring-bezier-v1",
    duration_ms: durationMs,
    from,
    to,
    samples,
  };
}

function smoothSpring(progress: number): number {
  const clamped = Math.min(1, Math.max(0, progress));
  const smooth = clamped * clamped * (3 - 2 * clamped);
  const settle = Math.sin(clamped * Math.PI) * 0.018 * (1 - clamped);
  return Math.min(1, Math.max(0, smooth + settle));
}

function roundedLerp(from: number, to: number, progress: number): number {
  return Math.round((from + (to - from) * progress) * 1000) / 1000;
}

function computeActionId(
  tool: string,
  action: string,
  target: ComputeVisualActionTarget | undefined,
): string {
  const ref = target?.ref ?? "no-ref";
  const point = target?.point
    ? `${target.point.x},${target.point.y}`
    : "no-point";
  return `${tool}:${action}:${ref}:${point}`;
}

function samePoint(
  left: ComputeVisualCursorPoint | ComputeVisualPointerSample,
  right: ComputeVisualCursorPoint | ComputeVisualPointerSample,
): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.coordinate_space.kind === right.coordinate_space.kind &&
    left.coordinate_space.origin === right.coordinate_space.origin &&
    left.coordinate_space.screenIndex === right.coordinate_space.screenIndex
  );
}

function readBounds(
  value: unknown,
): { x: number; y: number; w: number; h: number } | undefined {
  if (!isRecord(value)) return undefined;
  const x = readNumber(value.x);
  const y = readNumber(value.y);
  const w = readNumber(value.w ?? value.width);
  const h = readNumber(value.h ?? value.height);
  if (
    x === undefined ||
    y === undefined ||
    w === undefined ||
    h === undefined
  ) {
    return undefined;
  }
  return { x, y, w, h };
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
