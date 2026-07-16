/**
 * @owner       src/browser/ref-target.ts
 * @does        Resolve a snapshot ref through its renderer-owned node registry, prove an unobstructed hit point, project it into top-frame coordinates, and validate explicit coordinate input against the live viewport.
 * @needs       A snapshot-created window.__unicli_ref_nodes Map
 * @feeds       managed CDP input, Chrome extension input, direct coordinate input, and ref verification
 * @breaks      Malformed renderer results or unavailable/stale/mismatched/occluded refs are explicit and never fall through to a different input trust route.
 * @invariants  A ref targets only the exact node registered by the expected snapshot; trusted clicks descend every open shadow hit-test layer so a host cannot mask an occluding sibling; same-origin nested frames retain O(1) node lookup; cross-origin frames never produce guessed coordinates.
 * @side-effects Reads live DOM geometry without changing focus, scroll, or page content.
 * @perf        O(1) registry lookup, at most seven local hit tests, and O(frame depth) coordinate projection/hit validation.
 * @concurrency Snapshot identity is checked in the same renderer evaluation as lookup and hit testing; navigation or replacement turns every prior ref into a structured stale result.
 * @test        tests/unit/browser/ref-target.test.ts, tests/integration/browser-ref-capabilities.test.ts
 * @stability   experimental
 * @since       2026-07-16
 */

export type BrowserRefTargetStatus =
  | "found"
  | "registry_unavailable"
  | "stale"
  | "selector_mismatch"
  | "not_interactable"
  | "occluded"
  | "unsupported_frame";

export const BROWSER_VIEWPORT_EXPRESSION =
  "({ width: window.innerWidth, height: window.innerHeight })";

export interface BrowserViewport {
  width: number;
  height: number;
}

export type BrowserRefTargetResult =
  | {
      status: "found";
      ref: string;
      x: number;
      y: number;
      width: number;
      height: number;
      frame_depth: number;
    }
  | {
      status: Exclude<BrowserRefTargetStatus, "found">;
      ref: string;
    };

export function extractBrowserSnapshotRef(selector: string): string | null {
  const match = /\[data-unicli-ref=(?:"([^"]+)"|'([^']+)'|([^\]\s]+))\]/.exec(
    selector,
  );
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

export function buildBrowserRefTargetExpression(
  selector: string,
  expectedSnapshotId?: string,
): string | null {
  const ref = extractBrowserSnapshotRef(selector);
  if (ref === null) return null;
  const selectorJson = JSON.stringify(selector);
  const refJson = JSON.stringify(ref);
  const snapshotJson =
    expectedSnapshotId === undefined
      ? "null"
      : JSON.stringify(expectedSnapshotId);
  return `(() => {
    const ref = ${refJson};
    const expectedSnapshotId = ${snapshotJson};
    if (
      expectedSnapshotId !== null &&
      window.__unicli_ref_snapshot_id !== expectedSnapshotId
    ) {
      return { status: 'stale', ref };
    }
    const registry = window.__unicli_ref_nodes;
    if (!(registry instanceof Map)) return { status: 'registry_unavailable', ref };
    const element = registry.get(ref);
    if (!element || element.nodeType !== 1 || !element.isConnected) {
      return { status: 'stale', ref };
    }
    try {
      if (!element.matches(${selectorJson})) return { status: 'selector_mismatch', ref };
    } catch {
      return { status: 'selector_mismatch', ref };
    }
    const ownerWindow = element.ownerDocument?.defaultView;
    if (!ownerWindow) return { status: 'stale', ref };
    const style = ownerWindow.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.pointerEvents === 'none' ||
      rect.width <= 0 ||
      rect.height <= 0 ||
      element.disabled === true
    ) {
      return { status: 'not_interactable', ref };
    }
    const visibleLeft = Math.max(0, rect.left);
    const visibleTop = Math.max(0, rect.top);
    const visibleRight = Math.min(ownerWindow.innerWidth, rect.right);
    const visibleBottom = Math.min(ownerWindow.innerHeight, rect.bottom);
    if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) {
      return { status: 'not_interactable', ref };
    }
    const composedContains = (ancestor, descendant) => {
      let current = descendant;
      while (current) {
        if (current === ancestor || ancestor.contains(current)) return true;
        const root = current.getRootNode();
        if (!(root instanceof ShadowRoot)) return false;
        current = root.host;
      }
      return false;
    };
    const deepestHitAtPoint = (ownerDocument, x, y) => {
      let hit = ownerDocument.elementFromPoint(x, y);
      while (hit?.shadowRoot) {
        const nested = hit.shadowRoot.elementFromPoint(x, y);
        if (!nested || nested === hit) break;
        hit = nested;
      }
      return hit;
    };
    const pointAt = (xRatio, yRatio) => ({
      x: visibleLeft + (visibleRight - visibleLeft) * xRatio,
      y: visibleTop + (visibleBottom - visibleTop) * yRatio,
    });
    const candidates = [
      pointAt(0.5, 0.5),
      pointAt(0.25, 0.25),
      pointAt(0.75, 0.25),
      pointAt(0.25, 0.75),
      pointAt(0.75, 0.75),
      pointAt(0.5, 0.2),
      pointAt(0.5, 0.8),
    ];
    const point = candidates.find((candidate) => {
      try {
        return composedContains(
          element,
          deepestHitAtPoint(element.ownerDocument, candidate.x, candidate.y),
        );
      } catch {
        return false;
      }
    });
    if (!point) return { status: 'occluded', ref };
    let x = point.x;
    let y = point.y;
    let currentWindow = ownerWindow;
    let frameDepth = 0;
    while (currentWindow !== window) {
      let frameElement;
      try {
        frameElement = currentWindow.frameElement;
      } catch {
        return { status: 'unsupported_frame', ref };
      }
      if (!frameElement || !frameElement.isConnected) {
        return { status: 'unsupported_frame', ref };
      }
      const parentWindow = frameElement.ownerDocument?.defaultView;
      if (!parentWindow) return { status: 'unsupported_frame', ref };
      const frameStyle = parentWindow.getComputedStyle(frameElement);
      if (
        frameStyle.transform !== 'none' ||
        (frameStyle.zoom && Number.parseFloat(frameStyle.zoom) !== 1)
      ) {
        return { status: 'unsupported_frame', ref };
      }
      const frameRect = frameElement.getBoundingClientRect();
      if (
        frameStyle.display === 'none' ||
        frameStyle.visibility === 'hidden' ||
        frameStyle.pointerEvents === 'none' ||
        frameRect.width <= 0 ||
        frameRect.height <= 0
      ) {
        return { status: 'not_interactable', ref };
      }
      const parentX = x + frameRect.left + frameElement.clientLeft;
      const parentY = y + frameRect.top + frameElement.clientTop;
      let frameHit;
      try {
        frameHit = deepestHitAtPoint(
          frameElement.ownerDocument,
          parentX,
          parentY,
        );
      } catch {
        return { status: 'unsupported_frame', ref };
      }
      if (!composedContains(frameElement, frameHit)) {
        return { status: 'occluded', ref };
      }
      x = parentX;
      y = parentY;
      currentWindow = parentWindow;
      frameDepth += 1;
    }
    return {
      status: 'found',
      ref,
      x,
      y,
      width: rect.width,
      height: rect.height,
      frame_depth: frameDepth,
    };
  })()`;
}

export function readBrowserRefTargetResult(
  value: unknown,
): BrowserRefTargetResult {
  if (
    !isRecord(value) ||
    !isStatus(value.status) ||
    typeof value.ref !== "string"
  ) {
    throw new TypeError("Browser ref target resolver returned invalid data");
  }
  if (value.status !== "found") {
    return { status: value.status, ref: value.ref };
  }
  if (
    !finite(value.x) ||
    !finite(value.y) ||
    !positiveFinite(value.width) ||
    !positiveFinite(value.height) ||
    !nonnegativeInteger(value.frame_depth)
  ) {
    throw new TypeError(
      "Browser ref target resolver returned invalid geometry",
    );
  }
  return {
    status: "found",
    ref: value.ref,
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
    frame_depth: value.frame_depth,
  };
}

export function requireBrowserRefTarget(
  value: unknown,
): Extract<BrowserRefTargetResult, { status: "found" }> {
  const result = readBrowserRefTargetResult(value);
  if (result.status !== "found") {
    throw new BrowserRefTargetError(result.status, result.ref);
  }
  return result;
}

export class BrowserRefTargetError extends Error {
  readonly code: string;
  readonly retryable = false;
  readonly suggestion: string;

  constructor(
    readonly status: Exclude<BrowserRefTargetStatus, "found">,
    readonly ref: string,
  ) {
    super(refTargetMessage(status, ref));
    this.name = "BrowserRefTargetError";
    this.code =
      status === "stale" || status === "registry_unavailable"
        ? "stale_ref"
        : status === "selector_mismatch"
          ? "ref_not_found"
          : status === "unsupported_frame"
            ? "browser_frame_unsupported"
            : status === "occluded"
              ? "browser_selector_occluded"
              : "browser_selector_not_interactable";
    this.suggestion =
      status === "unsupported_frame"
        ? "Use a top-level, open-shadow, or same-origin-frame ref; cross-origin/OOPIF refs are not emitted by this route."
        : status === "occluded"
          ? "Take a fresh browser state, dismiss the covering surface, or choose another visible ref; Uni-CLI will not bypass an overlay with an untrusted DOM click."
          : "Take a fresh browser state snapshot and retry with one of its refs.";
  }
}

export class BrowserViewportPointError extends Error {
  readonly code:
    | "browser_coordinate_out_of_bounds"
    | "browser_viewport_invalid";
  readonly retryable = false;
  readonly suggestion: string;

  constructor(message: string, invalidViewport = false) {
    super(message);
    this.name = "BrowserViewportPointError";
    this.code = invalidViewport
      ? "browser_viewport_invalid"
      : "browser_coordinate_out_of_bounds";
    this.suggestion = invalidViewport
      ? "Take a fresh browser state and inspect the target before retrying coordinate input."
      : "Use a coordinate inside the current CSS-pixel viewport returned by browser state or screenshot evidence.";
  }
}

export function requireBrowserViewportPoint(
  value: unknown,
  x: number,
  y: number,
): BrowserViewport {
  if (
    !isRecord(value) ||
    !positiveFinite(value.width) ||
    !positiveFinite(value.height)
  ) {
    throw new BrowserViewportPointError(
      "Browser returned invalid viewport geometry",
      true,
    );
  }
  if (
    !finite(x) ||
    !finite(y) ||
    x < 0 ||
    y < 0 ||
    x >= value.width ||
    y >= value.height
  ) {
    throw new BrowserViewportPointError(
      `Browser coordinate (${String(x)}, ${String(y)}) is outside the ${String(value.width)}x${String(value.height)} CSS-pixel viewport`,
    );
  }
  return { width: value.width, height: value.height };
}

function refTargetMessage(
  status: Exclude<BrowserRefTargetStatus, "found">,
  ref: string,
): string {
  switch (status) {
    case "registry_unavailable":
      return `ref ${ref} has no live snapshot registry`;
    case "stale":
      return `ref ${ref} no longer identifies a connected element`;
    case "selector_mismatch":
      return `ref ${ref} no longer satisfies its selector contract`;
    case "not_interactable":
      return `ref ${ref} is hidden, disabled, pointer-inert, or has no rendered box`;
    case "occluded":
      return `ref ${ref} has no provably unobstructed point in the visible viewport`;
    case "unsupported_frame":
      return `ref ${ref} belongs to a frame whose coordinates cannot be proven`;
  }
}

function isStatus(value: unknown): value is BrowserRefTargetStatus {
  return (
    value === "found" ||
    value === "registry_unavailable" ||
    value === "stale" ||
    value === "selector_mismatch" ||
    value === "not_interactable" ||
    value === "occluded" ||
    value === "unsupported_frame"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positiveFinite(value: unknown): value is number {
  return finite(value) && value > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
