/**
 * @owner       src::transport::cascade
 * @does        Bind one immutable compute target, select only target-compatible transports, and evaluate condition waits from fresh snapshots.
 * @needs       compute wait/contracts, core envelopes, repair remedies, refs, transport types.
 * @feeds       compute CLI, registered compute pipeline steps, and computer-use action execution.
 * @breaks      Re-resolving a short alias after an await can dispatch against a different app; replaying an ambiguous mutation can duplicate host effects.
 * @invariants  One exact ref generation feeds validation, routing, enrichment, overlay evidence, and dispatch; a bound ref never crosses transport owners; app-scoped work never falls onto an unbound browser/screen; waits succeed only from an observed condition; cancellation is checked before every fallback.
 * @side-effects Opens and dispatches selected transport adapters and may allocate refs from snapshots.
 * @perf        One-shot actions are O(preferred transports + live ref buckets); condition waits repeat one target snapshot every 50ms until a 300s maximum deadline.
 * @concurrency A bound ref generation is revalidated after every awaited adapter setup before dispatch.
 * @test        tests/unit/compute-cascade.test.ts, tests/unit/compute-action-execution.test.ts
 * @stability   stable
 * @since       2026-06-29
 */

import { err, exitCodeFor, ok } from "../core/envelope.js";
import {
  computeCommandCanMutate,
  COMPUTE_REF_ACCEPTED_NAMESPACES,
  readForeignComputeRefOwner,
} from "../compute/contracts.js";
import {
  hasCdpTarget,
  readComputeTargetApp,
  transportForComputeRef,
  waitForComputeCondition,
} from "../compute/wait.js";
import { enrichErrorWithRemedy } from "../engine/repair/remedies.js";
import {
  describeElementRef,
  type ElementRef,
  type RefBucket,
  type RefStoreMatch,
} from "./refs.js";
import {
  isOperationOutcomeAmbiguousError,
  OperationOutcomeAmbiguousError,
} from "./contained-process.js";
import { isSidecarError } from "./sidecar.js";
import { cdpEndpointValidationError, readCdpEndpoint } from "./cdp-endpoint.js";
import type {
  ActionRequest,
  ActionResult,
  Snapshot,
  TransportBus,
  TransportContext,
  TransportKind,
} from "./types.js";

export const COMPUTE_PREFERENCE: Readonly<
  Record<string, readonly TransportKind[]>
> = {
  compute_apps: ["desktop-ax", "desktop-uia", "desktop-atspi", "subprocess"],
  compute_windows: [
    "desktop-ax",
    "desktop-uia",
    "desktop-atspi",
    "cdp-browser",
  ],
  compute_snapshot: [
    "desktop-ax",
    "desktop-uia",
    "desktop-atspi",
    "cdp-browser",
    "visual",
  ],
  compute_find: [
    "desktop-ax",
    "desktop-uia",
    "desktop-atspi",
    "cdp-browser",
    "visual",
  ],
  compute_screenshot: [
    "cdp-browser",
    "desktop-ax",
    "desktop-uia",
    "desktop-atspi",
    "visual",
  ],
  compute_observe: [
    "desktop-ax",
    "desktop-uia",
    "desktop-atspi",
    "cdp-browser",
  ],
  compute_wait: ["desktop-ax", "cdp-browser", "desktop-uia", "desktop-atspi"],
  compute_assert: [
    "desktop-ax",
    "cdp-browser",
    "desktop-uia",
    "desktop-atspi",
    "visual",
    "subprocess",
  ],
  compute_click: [
    "desktop-ax",
    "cdp-browser",
    "desktop-uia",
    "desktop-atspi",
    "visual",
  ],
  compute_type: [
    "desktop-ax",
    "cdp-browser",
    "desktop-uia",
    "desktop-atspi",
    "visual",
  ],
  compute_press: [
    "desktop-ax",
    "cdp-browser",
    "desktop-uia",
    "desktop-atspi",
    "visual",
  ],
  compute_scroll: [
    "desktop-ax",
    "cdp-browser",
    "desktop-uia",
    "desktop-atspi",
    "visual",
  ],
  compute_launch: ["subprocess", "desktop-ax", "desktop-uia", "desktop-atspi"],
  compute_cdp_attach: ["cdp-browser"],
  compute_evaluate: ["cdp-browser"],
};

const FOCUS_NORMALIZED_COMPUTE_STEPS = new Set([
  "compute_click",
  "compute_type",
  "compute_press",
  "compute_scroll",
]);

const DEFAULT_REF_TTL_MS = 60 * 60 * 1000;

export interface PreparedComputeRequest {
  request: ActionRequest;
  refMatch?: RefStoreMatch;
}

export type ComputeRequestPreparation =
  | { status: "ready"; prepared: PreparedComputeRequest }
  | { status: "rejected"; result: ActionResult<unknown> };

export function preferenceFor(
  step: string,
  platform: NodeJS.Platform,
): readonly TransportKind[] {
  const base = COMPUTE_PREFERENCE[step] ?? [];
  return base.filter((transport) =>
    transportSupportsPlatform(transport, platform),
  );
}

function preferenceForRequest(
  prepared: PreparedComputeRequest,
  platform: NodeJS.Platform,
): readonly TransportKind[] {
  const { request: req, refMatch } = prepared;
  const base = preferenceFor(req.kind, platform);
  const stableRef =
    refMatch?.ref.stable ??
    readStableRefParam(req.params.ref) ??
    readStableRefParam(req.params.stable);
  const owner = stableRef ? transportForComputeRef(stableRef) : undefined;
  if (owner) return base.includes(owner) ? [owner] : [];
  const app = readComputeTargetApp(req.params);
  if (hasCdpTarget(req.params)) {
    return base.includes("cdp-browser") ? ["cdp-browser"] : [];
  }
  if (!app && !hasNativeTarget(req.params)) return base;
  return base.filter((transport) =>
    transportCanHonorNativeTarget(transport, req.kind),
  );
}

function transportCanHonorNativeTarget(
  transport: TransportKind,
  step: string,
): boolean {
  if (
    transport === "desktop-ax" ||
    transport === "desktop-uia" ||
    transport === "desktop-atspi"
  ) {
    return true;
  }
  if (transport === "cdp-browser") {
    return step === "compute_cdp_attach";
  }
  return transport === "subprocess" && step === "compute_launch";
}

function readStableRefParam(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export async function tryCascade(
  bus: TransportBus,
  req: ActionRequest,
  platform: NodeJS.Platform = process.platform,
  transportCtx: TransportContext = { vars: {}, bus, refs: bus.refs },
  preparedRequest?: PreparedComputeRequest,
): Promise<ActionResult<unknown>> {
  const signal = req.signal ?? transportCtx.signal;
  signal?.throwIfAborted();
  const preparation = preparedRequest
    ? { status: "ready" as const, prepared: preparedRequest }
    : prepareComputeRequest(bus, {
        ...req,
        ...(signal ? { signal } : {}),
      });
  if (preparation.status === "rejected") return preparation.result;
  const prepared =
    signal && preparation.prepared.request.signal !== signal
      ? {
          ...preparation.prepared,
          request: { ...preparation.prepared.request, signal },
        }
      : preparation.prepared;
  const normalizedReq = prepared.request;
  if (normalizedReq.kind === "compute_find") {
    const result = findInRefStore(bus, normalizedReq.params);
    signal?.throwIfAborted();
    return result;
  }
  const refError = validatePreparedRef(bus, prepared);
  if (refError) return refError;

  if (normalizedReq.kind === "compute_wait") {
    return withRemedy(
      await waitForComputeCondition({
        params: normalizedReq.params,
        ref: prepared.refMatch?.ref,
        refs: bus.refs,
        ...(signal ? { signal } : {}),
        observe: (params, waitSignal) =>
          dispatchPreparedRequest(
            bus,
            {
              request: {
                kind: "compute_snapshot",
                params,
                canMutate: false,
                signal: waitSignal,
              },
            },
            platform,
            { ...transportCtx, signal: waitSignal },
          ),
      }),
    );
  }

  return (await dispatchPreparedRequest(bus, prepared, platform, transportCtx))
    .result;
}

interface PreparedDispatch {
  result: ActionResult<unknown>;
  transport?: TransportKind;
}

async function dispatchPreparedRequest(
  bus: TransportBus,
  prepared: PreparedComputeRequest,
  platform: NodeJS.Platform,
  transportCtx: TransportContext,
): Promise<PreparedDispatch> {
  const normalizedReq = prepared.request;
  const signal = normalizedReq.signal ?? transportCtx.signal;
  const canMutate = normalizedReq.canMutate === true;

  const order = preferenceForRequest(prepared, platform);
  if (order.length === 0) {
    return {
      result: withRemedy(
        err({
          transport: "visual",
          step: 0,
          action: normalizedReq.kind,
          reason: `no target-compatible transport advertises step ${normalizedReq.kind}`,
          suggestion:
            "bind the intended app/ref/CDP endpoint or run `unicli doctor compute`",
          minimum_capability: `compute.${normalizedReq.kind}.target_unavailable`,
          exit_code: exitCodeFor("service_unavailable"),
        }),
      ),
    };
  }

  const failures: string[] = [];
  let lastFailure: ActionResult<unknown> | undefined;
  for (const kind of order) {
    signal?.throwIfAborted();
    const staleBeforeOpen = validatePreparedRef(bus, prepared);
    if (staleBeforeOpen) return { result: staleBeforeOpen };
    let actionDispatched = false;
    try {
      const adapter = bus.get(kind);
      const adapted = adaptStep(normalizedReq, kind);
      const dispatchReq = normalizeFocusForTransport(
        adapted,
        kind,
        normalizedReq.kind,
      );
      await adapter.open(transportCtx);
      signal?.throwIfAborted();
      const staleAfterOpen = validatePreparedRef(bus, prepared);
      if (staleAfterOpen) return { result: staleAfterOpen };
      if (
        normalizedReq.kind === "compute_snapshot" &&
        (kind === "desktop-uia" ||
          kind === "desktop-atspi" ||
          kind === "cdp-browser")
      ) {
        const snapshot = await adapter.snapshot({
          format: readSnapshotFormat(normalizedReq.params),
          ...(normalizedReq.params.fresh === true ? { fresh: true } : {}),
          params: normalizedReq.params,
          ...(signal ? { signal } : {}),
        });
        signal?.throwIfAborted();
        return {
          result: ok(enrichSnapshotWithRefProvenance(bus, snapshot, kind)),
          transport: kind,
        };
      }
      actionDispatched = true;
      const result = await adapter.action<unknown>(dispatchReq);
      if (
        result.ok &&
        normalizedReq.kind === "compute_snapshot" &&
        kind === "desktop-ax"
      ) {
        const snapshot = await adapter.snapshot({
          format: readSnapshotFormat(normalizedReq.params),
          ...(normalizedReq.params.fresh === true ? { fresh: true } : {}),
          params: normalizedReq.params,
          ...(signal ? { signal } : {}),
        });
        signal?.throwIfAborted();
        return {
          result: ok(enrichSnapshotWithRefProvenance(bus, snapshot, kind)),
          transport: kind,
        };
      }
      if (result.ok) return { result, transport: kind };
      lastFailure = result;
      failures.push(
        `${kind}:${result.error.minimum_capability ?? result.error.reason}`,
      );
    } catch (error) {
      if (isOperationOutcomeAmbiguousError(error)) throw error;
      if (signal?.aborted) {
        if (
          canMutate &&
          actionDispatched &&
          isCancellationCompletion(error, signal)
        ) {
          throw new OperationOutcomeAmbiguousError(
            normalizedReq.kind,
            signal.reason,
          );
        }
        if (isCancellationCompletion(error, signal)) throw signal.reason;
        throw error;
      }
      if (isSidecarError(error)) {
        lastFailure = err({
          transport: kind,
          step: 0,
          action: normalizedReq.kind,
          reason: error.reason,
          suggestion: error.suggestion,
          minimum_capability: error.minimum_capability,
          exit_code: error.exit_code,
        });
        failures.push(`${kind}:${error.minimum_capability}`);
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${kind}:${message}`);
    }
  }

  if (order.length === 1 && lastFailure) {
    return { result: withRemedy(lastFailure) };
  }

  return {
    result: withRemedy(
      err({
        transport: order[0] ?? "visual",
        step: 0,
        action: normalizedReq.kind,
        reason: `all target-compatible transports failed: ${failures.join("; ")}`,
        suggestion: "inspect each transport: unicli doctor compute",
        minimum_capability: `compute.${normalizedReq.kind}.no-transport-available`,
        exit_code: exitCodeFor("service_unavailable"),
      }),
    ),
  };
}

export function prepareComputeRequest(
  bus: TransportBus,
  req: ActionRequest,
): ComputeRequestPreparation {
  const targetError = validateComputeTargetParams(req.kind, req.params);
  if (targetError) return { status: "rejected", result: targetError };
  const normalizedReq = normalizeComputeRequest({
    ...req,
    canMutate: computeCommandCanMutate(req.kind),
  });
  if (normalizedReq.kind === "compute_find") {
    return { status: "ready", prepared: { request: normalizedReq } };
  }

  const refValue = normalizedReq.params.ref;
  if (typeof refValue !== "string" || refValue.length === 0) {
    return { status: "ready", prepared: { request: normalizedReq } };
  }
  const foreignOwner = readForeignComputeRefOwner(refValue);
  if (foreignOwner === "unknown") {
    return { status: "rejected", result: unresolvableRef(req.kind, refValue) };
  }
  if (foreignOwner !== undefined) {
    return {
      status: "rejected",
      result: foreignRef(req.kind, refValue, foreignOwner),
    };
  }

  const allMatches = bus.refs.matches(refValue);
  const selection = selectRefMatchesForTarget(allMatches, normalizedReq.params);
  const matches = selection.matches;
  if (selection.constrained && allMatches.length > 0 && matches.length === 0) {
    return {
      status: "rejected",
      result: refTargetMismatch(
        req.kind,
        refValue,
        allMatches,
        normalizedReq.params,
      ),
    };
  }
  if (matches.length > 1) {
    return {
      status: "rejected",
      result: refAmbiguous(req.kind, refValue, matches),
    };
  }
  const refMatch = matches[0];
  if (!refMatch) {
    const owner = transportForComputeRef(refValue);
    if (owner) {
      if (
        owner === "cdp-browser" &&
        readCdpEndpoint(normalizedReq.params) === undefined
      ) {
        return {
          status: "rejected",
          result: refExpired(
            req.kind,
            refValue,
            "a direct CDP stable ref requires its explicit endpoint",
          ),
        };
      }
      if (
        isNativeComputeTransport(owner) &&
        !hasExactDirectNativeTarget(normalizedReq.params, refValue, owner)
      ) {
        return {
          status: "rejected",
          result: refExpired(
            req.kind,
            refValue,
            "a direct native stable ref requires an app, matching exact window id, and valid traversal path",
          ),
        };
      }
      return {
        status: "ready",
        prepared: {
          request: {
            ...normalizedReq,
            params: { ...normalizedReq.params, stable: refValue },
          },
        },
      };
    }
    return {
      status: "rejected",
      result: refExpired(req.kind, refValue, "no live ref matched the target"),
    };
  }

  if (
    transportForComputeRef(refMatch.ref.stable) === "cdp-browser" &&
    !readExactCdpRefEndpoint(refMatch.ref)
  ) {
    return {
      status: "rejected",
      result: refExpired(
        req.kind,
        refValue,
        "the persisted CDP ref predates exact renderer binding",
      ),
    };
  }
  const nativeOwner = transportForComputeRef(refMatch.ref.stable);
  if (
    nativeOwner &&
    isNativeComputeTransport(nativeOwner) &&
    !hasExactNativeRefIdentity(refMatch.ref, nativeOwner)
  ) {
    return {
      status: "rejected",
      result: refExpired(
        req.kind,
        refValue,
        "the persisted native ref predates exact window binding",
      ),
    };
  }

  const prepared: PreparedComputeRequest = {
    request: enrichComputeRequestFromMatch(normalizedReq, refMatch.ref),
    refMatch,
  };
  const refError = validatePreparedRef(bus, prepared);
  return refError
    ? { status: "rejected", result: refError }
    : { status: "ready", prepared };
}

function selectRefMatchesForTarget(
  matches: readonly RefStoreMatch[],
  params: Readonly<Record<string, unknown>>,
): { constrained: boolean; matches: RefStoreMatch[] } {
  const windowId = params.windowId;
  const pid = params.pid;
  const app =
    typeof params.app === "string" && params.app.trim()
      ? params.app.trim().toLowerCase()
      : undefined;
  const endpoint = readCdpEndpoint(params);
  const constrained =
    windowId !== undefined ||
    pid !== undefined ||
    app !== undefined ||
    endpoint !== undefined;
  if (!constrained) return { constrained: false, matches: [...matches] };

  const compatible: RefStoreMatch[] = [];
  const unknown: RefStoreMatch[] = [];
  for (const match of matches) {
    const compatibility = refTargetCompatibility(match.ref, {
      windowId,
      pid,
      app,
      endpoint,
    });
    if (compatibility === "compatible") compatible.push(match);
    if (compatibility === "unknown") unknown.push(match);
  }
  return {
    constrained: true,
    matches: compatible.length > 0 ? compatible : unknown,
  };
}

function refTargetCompatibility(
  ref: ElementRef,
  target: {
    windowId: unknown;
    pid: unknown;
    app: string | undefined;
    endpoint: ReturnType<typeof readCdpEndpoint>;
  },
): "compatible" | "incompatible" | "unknown" {
  let hasUnknownIdentity = false;
  if (target.windowId !== undefined) {
    if (ref.windowId === undefined) hasUnknownIdentity = true;
    else if (
      String(ref.windowId).trim().toLowerCase() !==
      String(target.windowId).trim().toLowerCase()
    ) {
      return "incompatible";
    }
  }
  if (target.pid !== undefined) {
    if (ref.pid === undefined) hasUnknownIdentity = true;
    else if (ref.pid !== target.pid) return "incompatible";
  }
  if (target.app !== undefined) {
    if (ref.app === undefined) hasUnknownIdentity = true;
    else if (ref.app.trim().toLowerCase() !== target.app) {
      return "incompatible";
    }
  }
  if (target.endpoint) {
    const refEndpoint = readExactCdpRefEndpoint(ref);
    if (!refEndpoint) hasUnknownIdentity = true;
    else {
      if (refEndpoint.port !== target.endpoint.port) return "incompatible";
      if (
        target.endpoint.webSocketDebuggerUrl !== undefined &&
        refEndpoint.webSocketDebuggerUrl !==
          target.endpoint.webSocketDebuggerUrl
      ) {
        return "incompatible";
      }
      if (
        target.endpoint.targetId !== undefined &&
        refEndpoint.targetId !== target.endpoint.targetId
      ) {
        return "incompatible";
      }
    }
  }
  return hasUnknownIdentity ? "unknown" : "compatible";
}

function validateComputeTargetParams(
  action: string,
  params: Record<string, unknown>,
): ActionResult<unknown> | undefined {
  for (const key of ["focus", "background"] as const) {
    if (params[key] !== undefined && typeof params[key] !== "boolean") {
      return invalidComputeTarget(
        action,
        `${key} must be boolean`,
        `pass a boolean ${key} option`,
      );
    }
  }
  if (params.focus === true && params.background === true) {
    return invalidComputeTarget(
      action,
      "focus and background cannot both be true",
      "choose either foreground focus or explicit background control",
    );
  }
  for (const key of ["app", "bundleId", "processName"] as const) {
    if (
      params[key] !== undefined &&
      (typeof params[key] !== "string" || !params[key].trim())
    ) {
      return invalidComputeTarget(
        action,
        `${key} must be a non-empty string`,
        `pass a non-empty ${key} target`,
      );
    }
  }
  if (
    params.pid !== undefined &&
    (typeof params.pid !== "number" ||
      !Number.isSafeInteger(params.pid) ||
      params.pid < 1)
  ) {
    return invalidComputeTarget(
      action,
      "pid must be a positive integer",
      "pass the numeric process id reported by `unicli compute apps`",
    );
  }
  if (
    params.windowId !== undefined &&
    !isValidNativeWindowId(params.windowId)
  ) {
    return invalidComputeTarget(
      action,
      "windowId must be a positive integer or non-empty native window id",
      "pass the windowId reported by `unicli compute windows`",
    );
  }

  const hasPortHint = params.port !== undefined;
  const hasWebSocketHint = params.webSocketDebuggerUrl !== undefined;
  const endpointValidationError = cdpEndpointValidationError(params);
  const endpoint = readCdpEndpoint(params);
  if (
    endpointValidationError ||
    ((hasPortHint || hasWebSocketHint) && !endpoint)
  ) {
    return invalidComputeTarget(
      action,
      endpointValidationError ??
        "the CDP endpoint is invalid or its port and WebSocket URL disagree",
      "pass one reachable port, one ws:/wss: renderer URL, or a matching pair",
    );
  }
  if (endpoint && (params.pid !== undefined || params.windowId !== undefined)) {
    return invalidComputeTarget(
      action,
      "native pid/windowId and CDP endpoint target different surfaces",
      "choose either a native app/window target or one CDP renderer endpoint",
    );
  }
  return undefined;
}

function hasNativeTarget(params: Record<string, unknown>): boolean {
  return ["app", "bundleId", "processName", "pid", "windowId"].some(
    (key) => params[key] !== undefined,
  );
}

function isValidNativeWindowId(value: unknown): boolean {
  return (
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) ||
    (typeof value === "string" && value.trim().length > 0)
  );
}

function invalidComputeTarget(
  action: string,
  reason: string,
  suggestion: string,
): ActionResult<unknown> {
  return withRemedy(
    err({
      transport: "visual",
      step: 0,
      action,
      reason,
      suggestion,
      minimum_capability: `compute.${action}.invalid_input`,
      exit_code: exitCodeFor("usage_error"),
    }),
  );
}

function hasExactDirectNativeTarget(
  params: Record<string, unknown>,
  stable: string,
  transport: TransportKind,
): boolean {
  const windowId = params.windowId;
  const prefix = `${transport}:`;
  const scopeEnd = stable.indexOf(":", prefix.length);
  const scope =
    scopeEnd >= 0 ? stable.slice(prefix.length, scopeEnd).toLowerCase() : "";
  const stableWindowId = scope.startsWith("window-")
    ? scope.slice("window-".length)
    : undefined;
  const path = scopeEnd >= 0 ? stable.slice(scopeEnd + 1) : "";
  const segments = path ? path.split("/") : [];
  return (
    stableWindowId !== undefined &&
    (windowId === undefined ||
      (isValidNativeWindowId(windowId) &&
        stableWindowId === String(windowId).trim().toLowerCase())) &&
    (transport !== "desktop-ax" ||
      (readComputeTargetApp(params) !== undefined &&
        isValidNativeWindowId(windowId))) &&
    segments.length > 0 &&
    segments.length <= 128 &&
    segments.every((segment, index) => {
      const match = /^.+\[(\d+)\]$/.exec(segment);
      if (match?.[1] === undefined) return false;
      const childIndex = Number(match[1]);
      return (
        Number.isSafeInteger(childIndex) &&
        childIndex >= 0 &&
        (index > 0 || childIndex === 0)
      );
    })
  );
}

function hasExactNativeRefIdentity(
  ref: ElementRef,
  transport: TransportKind,
): boolean {
  if (!ref.app || ref.windowId === undefined) return false;
  return hasExactDirectNativeTarget(
    { app: ref.app, windowId: ref.windowId },
    ref.stable,
    transport,
  );
}

function isNativeComputeTransport(transport: TransportKind): boolean {
  return (
    transport === "desktop-ax" ||
    transport === "desktop-uia" ||
    transport === "desktop-atspi"
  );
}

function readExactCdpRefEndpoint(
  ref: ElementRef,
): ReturnType<typeof readCdpEndpoint> {
  if (!ref.cdpEndpoint) return undefined;
  const endpoint = readCdpEndpoint({ ...ref.cdpEndpoint });
  return endpoint?.webSocketDebuggerUrl ? endpoint : undefined;
}

function normalizeComputeRequest(req: ActionRequest): ActionRequest {
  if (!FOCUS_NORMALIZED_COMPUTE_STEPS.has(req.kind)) return req;
  const { background: _background, ...params } = req.params;
  return {
    ...req,
    params: {
      ...params,
      focus: req.params.focus === true,
    },
  };
}

function normalizeFocusForTransport(
  req: ActionRequest,
  transport: TransportKind,
  computeKind: string,
): ActionRequest {
  if (
    transport !== "visual" ||
    !FOCUS_NORMALIZED_COMPUTE_STEPS.has(computeKind)
  ) {
    return req;
  }
  if (req.params.focus === true) return req;
  return {
    ...req,
    params: {
      ...req.params,
      focus: true,
    },
  };
}

function isCancellationCompletion(
  error: unknown,
  signal: AbortSignal,
): boolean {
  return (
    error === signal.reason ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function validatePreparedRef(
  bus: TransportBus,
  prepared: PreparedComputeRequest,
): ActionResult<unknown> | undefined {
  const { request, refMatch } = prepared;
  if (!refMatch) return undefined;
  const refValue =
    typeof request.params.ref === "string"
      ? request.params.ref
      : refMatch.ref.alias;
  if (!bus.refs.isCurrent(refMatch)) {
    return refExpired(
      request.kind,
      refValue,
      "ref binding changed before dispatch",
    );
  }
  if (isRefBucketExpired(refMatch.bucket)) {
    return refExpired(
      request.kind,
      refValue,
      `ref ${refValue} expired; bucket age ${Date.now() - refMatch.bucket.createdAt}ms exceeds ${readRefTtlMs()}ms`,
    );
  }
  if (request.canMutate !== true) return undefined;
  if (isDisabledRef(refMatch.ref)) {
    return elementDisabled(request.kind, refValue, refMatch.ref);
  }
  if (isOffScreenRef(refMatch.ref)) {
    return elementOffScreen(request.kind, refValue, refMatch.ref);
  }
  if (isMinimizedRef(refMatch.ref)) {
    return windowMinimized(request.kind, refValue, refMatch.ref);
  }
  return undefined;
}

function foreignRef(
  action: string,
  ref: string,
  owner: string,
): ActionResult<unknown> {
  return withRemedy(
    err({
      transport: "visual",
      step: 0,
      action,
      reason: `foreign_ref: ${ref} belongs to ${owner}, not Uni-CLI compute`,
      suggestion:
        owner === "olo.accessibility"
          ? "route this ref to OLo's accessibility provider, or run `unicli compute snapshot` to allocate a Uni-CLI compute ref"
          : "route this ref to its owning provider, or run `unicli compute snapshot` to allocate a Uni-CLI compute ref",
      minimum_capability: `compute.${action}.foreign_ref`,
      exit_code: exitCodeFor("usage_error"),
    }),
  );
}

function unresolvableRef(action: string, ref: string): ActionResult<unknown> {
  return withRemedy(
    err({
      transport: "visual",
      step: 0,
      action,
      reason: `unresolvable_ref: ${ref} is outside Uni-CLI compute ref namespaces`,
      suggestion: `use one of these namespaces: ${COMPUTE_REF_ACCEPTED_NAMESPACES.join("; ")}`,
      minimum_capability: `compute.${action}.unresolvable_ref`,
      exit_code: exitCodeFor("usage_error"),
    }),
  );
}

function refExpired(
  action: string,
  ref: string,
  reason: string,
): ActionResult<unknown> {
  return withRemedy(
    err({
      transport: "visual",
      step: 0,
      action,
      reason: `${reason}: ${ref}`,
      suggestion: "run `unicli compute snapshot` again, then retry",
      minimum_capability: `compute.${action}.ref_expired`,
      exit_code: exitCodeFor("empty_result"),
    }),
  );
}

function refAmbiguous(
  action: string,
  ref: string,
  matches: readonly RefStoreMatch[],
): ActionResult<unknown> {
  const candidates = matches
    .map(
      ({ ref: element, bucket }) =>
        `${bucket.transport}/${bucket.scope}=${element.stable}`,
    )
    .join(", ");
  return withRemedy(
    err({
      transport: "visual",
      step: 0,
      action,
      reason: `ref_ambiguous: ${ref} matches multiple live targets (${candidates})`,
      suggestion:
        "pass one stable ref from the intended target, or provide its exact windowId or CDP endpoint when the command supports target hints",
      minimum_capability: `compute.${action}.ref_ambiguous`,
      exit_code: exitCodeFor("empty_result"),
    }),
  );
}

function refTargetMismatch(
  action: string,
  ref: string,
  matches: readonly RefStoreMatch[],
  params: Readonly<Record<string, unknown>>,
): ActionResult<unknown> {
  const candidates = matches
    .map(
      ({ ref: element, bucket }) =>
        `${bucket.transport}/${bucket.scope}=${element.stable}`,
    )
    .join(", ");
  const requested = [
    params.app === undefined ? undefined : `app=${String(params.app)}`,
    params.pid === undefined ? undefined : `pid=${String(params.pid)}`,
    params.windowId === undefined
      ? undefined
      : `windowId=${String(params.windowId)}`,
    params.targetId === undefined
      ? undefined
      : `targetId=${String(params.targetId)}`,
    params.port === undefined ? undefined : `port=${String(params.port)}`,
    params.webSocketDebuggerUrl === undefined
      ? undefined
      : `webSocketDebuggerUrl=${String(params.webSocketDebuggerUrl)}`,
  ]
    .filter((value): value is string => Boolean(value))
    .join(", ");
  return withRemedy(
    err({
      transport: "visual",
      step: 0,
      action,
      reason: `ref_target_mismatch: ${ref} does not belong to the requested target (${requested}); live candidates: ${candidates}`,
      suggestion:
        "use the stable ref from the requested target, or refresh that exact target and use its replacement alias",
      minimum_capability: `compute.${action}.ref_target_mismatch`,
      exit_code: exitCodeFor("usage_error"),
    }),
  );
}

function elementDisabled(
  action: string,
  ref: string,
  element: ElementRef,
): ActionResult<unknown> {
  return withRemedy(
    err({
      transport: "visual",
      step: 0,
      action,
      reason: `target element is disabled: ${ref}${element.name ? ` (${element.name})` : ""}`,
      suggestion: "wait for the element to become enabled, then retry",
      minimum_capability: `compute.${action}.element_disabled`,
      exit_code: exitCodeFor("empty_result"),
    }),
  );
}

function isDisabledRef(ref: ElementRef): boolean {
  const states = new Set(
    (ref.states ?? []).map((state) => state.toLowerCase()),
  );
  return (
    states.has("disabled") ||
    states.has("unavailable") ||
    states.has("aria-disabled")
  );
}

function elementOffScreen(
  action: string,
  ref: string,
  element: ElementRef,
): ActionResult<unknown> {
  return withRemedy(
    err({
      transport: "visual",
      step: 0,
      action,
      reason: `target element is off screen: ${ref}${element.name ? ` (${element.name})` : ""}`,
      suggestion: "scroll the element into view or take a fresh snapshot",
      minimum_capability: `compute.${action}.element_off_screen`,
      exit_code: exitCodeFor("empty_result"),
    }),
  );
}

function isOffScreenRef(ref: ElementRef): boolean {
  const bounds = ref.bounds;
  if (!bounds) return false;
  return (
    bounds.w <= 0 ||
    bounds.h <= 0 ||
    bounds.x + bounds.w <= 0 ||
    bounds.y + bounds.h <= 0
  );
}

function windowMinimized(
  action: string,
  ref: string,
  element: ElementRef,
): ActionResult<unknown> {
  return withRemedy(
    err({
      transport: "visual",
      step: 0,
      action,
      reason: `target window is minimized or hidden: ${ref}${element.name ? ` (${element.name})` : ""}`,
      suggestion: "restore the target window or retry with explicit focus",
      minimum_capability: `compute.${action}.window_minimized`,
      exit_code: exitCodeFor("empty_result"),
    }),
  );
}

function isMinimizedRef(ref: ElementRef): boolean {
  const states = new Set(
    (ref.states ?? []).map((state) => state.toLowerCase()),
  );
  return (
    states.has("minimized") || states.has("hidden") || states.has("collapsed")
  );
}

function isRefBucketExpired(bucket: RefBucket): boolean {
  return Date.now() - bucket.createdAt > readRefTtlMs();
}

function readRefTtlMs(): number {
  const raw = process.env.UNICLI_COMPUTE_REF_TTL_MS;
  if (!raw) return DEFAULT_REF_TTL_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REF_TTL_MS;
}

function readSnapshotFormat(
  params: Record<string, unknown>,
): "compact" | "tree" | "json" | undefined {
  const format = params.format;
  return format === "compact" || format === "tree" || format === "json"
    ? format
    : undefined;
}

interface LocatedRef {
  ref: ElementRef;
  bucket: RefBucket;
}

function findInRefStore(
  bus: TransportBus,
  params: Record<string, unknown>,
): ActionResult<unknown> {
  const role = typeof params.role === "string" ? simplifyRole(params.role) : "";
  const name = typeof params.name === "string" ? params.name.toLowerCase() : "";
  const text = typeof params.text === "string" ? params.text.toLowerCase() : "";
  const matches = findRefMatches(bus).filter(({ ref }) => {
    const roleMatches = !role || simplifyRole(ref.role) === role;
    const nameMatches = !name || (ref.name ?? "").toLowerCase().includes(name);
    const textMatches =
      !text ||
      (ref.value ?? "").toLowerCase().includes(text) ||
      (ref.name ?? "").toLowerCase().includes(text);
    return (
      roleMatches &&
      nameMatches &&
      textMatches &&
      refMatchesFindTarget(ref, params)
    );
  });

  if (params.first === true) {
    if (isAmbiguousFind(matches, params)) return findAmbiguous(matches, params);
    const first = matches[0];
    return first
      ? ok(
          describeElementRef(first.ref, first.bucket, {
            ttlMs: readRefTtlMs(),
          }),
        )
      : findEmpty(params);
  }
  return ok(
    matches.map((match) =>
      describeElementRef(match.ref, match.bucket, { ttlMs: readRefTtlMs() }),
    ),
  );
}

function refMatchesFindTarget(
  ref: ElementRef,
  params: Record<string, unknown>,
): boolean {
  const app = readComputeTargetApp(params);
  if (app && normalizeTargetText(ref.app) !== normalizeTargetText(app)) {
    return false;
  }
  if (typeof params.pid === "number" && ref.pid !== params.pid) return false;
  if (
    params.windowId !== undefined &&
    String(ref.windowId) !== String(params.windowId)
  ) {
    return false;
  }
  return true;
}

function normalizeTargetText(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase() ?? "";
}

function findRefMatches(bus: TransportBus): LocatedRef[] {
  return bus.refs
    .buckets()
    .flatMap((bucket) =>
      Array.from(bucket.byAlias.values()).map((ref) => ({ ref, bucket })),
    );
}

function isAmbiguousFind(
  matches: readonly LocatedRef[],
  params: Record<string, unknown>,
): boolean {
  if (matches.length < 2) return false;
  if (typeof params.pid === "number" || typeof params.windowId === "string") {
    return false;
  }
  const scopes = new Set(
    matches.map(
      ({ ref }) => `${ref.app ?? ""}:${ref.pid ?? ""}:${scopeOf(ref)}`,
    ),
  );
  return scopes.size > 1;
}

function scopeOf(ref: ElementRef): string {
  const stableParts = ref.stable.split(":");
  return stableParts.length >= 3 ? (stableParts[1] ?? "") : "";
}

function findAmbiguous(
  matches: readonly LocatedRef[],
  params: Record<string, unknown>,
): ActionResult<unknown> {
  return withRemedy(
    err({
      transport: "visual",
      step: 0,
      action: "compute_find",
      reason: `multiple refs matched ${JSON.stringify(params)} across ${matches.length} targets`,
      suggestion:
        "disambiguate with app, pid, window id, or inspect `unicli compute windows --app <name>`",
      minimum_capability: "compute.compute_find.app_ambiguous",
      exit_code: exitCodeFor("empty_result"),
    }),
  );
}

function findEmpty(params: Record<string, unknown>): ActionResult<unknown> {
  return withRemedy(
    err({
      transport: "visual",
      step: 0,
      action: "compute_find",
      reason: `no refs matched ${JSON.stringify(params)}`,
      suggestion: "run `unicli compute snapshot` again, then retry find",
      minimum_capability: "compute.compute_find.ref-store",
      exit_code: exitCodeFor("empty_result"),
    }),
  );
}

function withRemedy<T>(result: ActionResult<T>): ActionResult<T> {
  if (result.ok) return result;
  return { ...result, error: enrichErrorWithRemedy(result.error) };
}

function simplifyRole(role: string): string {
  return ROLE_SIMPLIFY[role] ?? role.toLowerCase();
}

function enrichSnapshotWithRefProvenance(
  bus: TransportBus,
  snapshot: Snapshot,
  transport: TransportKind,
): Snapshot {
  const scope = readSnapshotRefScope(snapshot.refs);
  const buckets = bus.refs
    .buckets()
    .filter(
      (bucket) =>
        bucket.transport === transport &&
        (scope === undefined || bucket.scope === scope),
    );
  const records = buckets.flatMap((bucket) =>
    Array.from(bucket.byAlias.values()).map((ref) =>
      describeElementRef(ref, bucket, { ttlMs: readRefTtlMs() }),
    ),
  );
  if (records.length === 0) return snapshot;
  const refs = isRecord(snapshot.refs) ? snapshot.refs : {};
  return {
    ...snapshot,
    refs: {
      ...refs,
      provenance: {
        provider: "unicli.compute",
        accepted_namespaces: [...COMPUTE_REF_ACCEPTED_NAMESPACES],
        records,
      },
    },
  };
}

function readSnapshotRefScope(refs: Snapshot["refs"]): string | undefined {
  if (!isRecord(refs) || typeof refs.scope !== "string") return undefined;
  return refs.scope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ROLE_SIMPLIFY: Readonly<Record<string, string>> = {
  AXButton: "button",
  AXTextField: "input",
  AXTextArea: "textarea",
  AXStaticText: "text",
  AXMenuItem: "menuitem",
  AXCheckBox: "checkbox",
  AXRadioButton: "radio",
  AXLink: "link",
  AXWindow: "window",
  Button: "button",
  Edit: "input",
  Text: "text",
  MenuItem: "menuitem",
  CheckBox: "checkbox",
  RadioButton: "radio",
  Hyperlink: "link",
  Window: "window",
  push_button: "button",
  text: "input",
  menu_item: "menuitem",
  check_box: "checkbox",
  radio_button: "radio",
  link: "link",
  frame: "window",
};

function transportSupportsPlatform(
  transport: TransportKind,
  platform: NodeJS.Platform,
): boolean {
  if (transport === "desktop-ax") return platform === "darwin";
  if (transport === "desktop-uia") return platform === "win32";
  if (transport === "desktop-atspi") return platform === "linux";
  return true;
}

function adaptStep(
  req: ActionRequest,
  transport: TransportKind,
): ActionRequest {
  const kind = STEP_ADAPTERS[transport]?.[req.kind] ?? req.kind;
  return { ...req, kind };
}

export function enrichComputeRequestFromRefs(
  bus: TransportBus,
  req: ActionRequest,
): ActionRequest {
  const refValue = req.params.ref;
  if (typeof refValue !== "string") return req;
  const matches = selectRefMatchesForTarget(
    bus.refs.matches(refValue),
    req.params,
  ).matches;
  const match = matches.length === 1 ? matches[0] : undefined;
  return match ? enrichComputeRequestFromMatch(req, match.ref) : req;
}

function enrichComputeRequestFromMatch(
  req: ActionRequest,
  ref: ElementRef,
): ActionRequest {
  const boundsCenter =
    ref.bounds === undefined
      ? {}
      : {
          x: ref.bounds.x + ref.bounds.w / 2,
          y: ref.bounds.y + ref.bounds.h / 2,
          coordinateSpace: "screen",
          ...(typeof ref.screenIndex === "number" &&
          Number.isFinite(ref.screenIndex)
            ? { screenIndex: Math.trunc(ref.screenIndex) }
            : {}),
        };

  return {
    ...req,
    params: {
      ...boundsCenter,
      role: ref.role,
      ...(ref.name ? { title: ref.name, name: ref.name } : {}),
      stable: ref.stable,
      ...(ref.bounds ? { bounds: ref.bounds } : {}),
      ...req.params,
      ...(ref.app &&
      (ref.windowId === undefined ||
        transportForComputeRef(ref.stable) === "desktop-ax")
        ? { app: ref.app }
        : {}),
      ...(ref.pid === undefined ? {} : { pid: ref.pid }),
      ...(ref.windowId === undefined ? {} : { windowId: ref.windowId }),
      ...ref.cdpEndpoint,
    },
  };
}

const STEP_ADAPTERS: Readonly<
  Partial<Record<TransportKind, Readonly<Record<string, string>>>>
> = {
  "desktop-ax": {
    compute_apps: "ax_apps",
    compute_windows: "ax_windows",
    compute_snapshot: "ax_snapshot",
    compute_click: "ax_press",
    compute_type: "ax_set_value",
    compute_press: "ax_background_press",
    compute_scroll: "ax_scroll",
    compute_screenshot: "ax_screenshot",
    compute_launch: "launch_app",
  },
  "desktop-uia": {
    compute_apps: "uia_apps",
    compute_windows: "uia_windows",
    compute_snapshot: "uia_snapshot",
    compute_find: "uia_find",
    compute_click: "uia_invoke",
    compute_type: "uia_set_value",
    compute_press: "uia_press",
    compute_scroll: "uia_scroll",
    compute_screenshot: "uia_screenshot",
    compute_wait: "uia_wait",
    compute_observe: "uia_observe",
    compute_assert: "uia_assert",
    compute_launch: "launch_app",
  },
  "desktop-atspi": {
    compute_apps: "atspi_apps",
    compute_windows: "atspi_windows",
    compute_snapshot: "atspi_snapshot",
    compute_find: "atspi_find",
    compute_click: "atspi_invoke",
    compute_type: "atspi_set_value",
    compute_press: "atspi_press",
    compute_scroll: "atspi_scroll",
    compute_screenshot: "atspi_screenshot",
    compute_wait: "atspi_wait",
    compute_observe: "atspi_observe",
    compute_assert: "atspi_assert",
    compute_launch: "launch_app",
  },
  "cdp-browser": {
    compute_snapshot: "snapshot",
    compute_click: "click",
    compute_type: "type",
    compute_press: "press",
    compute_scroll: "scroll",
    compute_screenshot: "screenshot",
    compute_cdp_attach: "cdp_attach",
    compute_evaluate: "evaluate",
    compute_wait: "wait",
  },
  visual: {
    compute_snapshot: "visual_snapshot",
    compute_click: "visual_click",
    compute_type: "visual_type",
    compute_press: "visual_key",
    compute_scroll: "visual_scroll",
    compute_screenshot: "visual_snapshot",
    compute_wait: "visual_wait",
  },
  subprocess: {
    compute_apps: "exec",
    compute_launch: "launch_app",
    compute_wait: "wait",
  },
};
