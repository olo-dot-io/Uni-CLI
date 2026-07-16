/**
 * @owner       src::transport::cascade
 * @does        Bind one immutable compute target, select transports by capability/ref provenance, and return the first successful envelope.
 * @needs       core envelopes, compute contracts, repair remedies, refs, transport types.
 * @feeds       compute CLI, registered compute pipeline steps, and computer-use action execution.
 * @breaks      Re-resolving a short alias after an await can dispatch against a different app; replaying an ambiguous mutation can duplicate host effects.
 * @invariants  One exact ref generation feeds validation, routing, enrichment, overlay evidence, and dispatch; ambiguous aliases never dispatch; cancellation is checked before every fallback.
 * @side-effects Opens and dispatches selected transport adapters and may allocate refs from snapshots.
 * @perf        O(number of preferred transports + live ref buckets).
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
  compute_wait: [
    "desktop-ax",
    "cdp-browser",
    "desktop-uia",
    "desktop-atspi",
    "visual",
    "subprocess",
  ],
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

const noStoreRefPassthrough = new WeakSet<TransportBus>();

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
  const owner = transportForStableRef(
    refMatch?.ref.stable ?? readStableRefParam(req.params.ref),
  );
  if (owner) return preferTransport(base, owner);
  if (hasCdpSessionParams(req.params)) {
    return preferTransport(base, "cdp-browser");
  }
  return base;
}

function preferTransport(
  transports: readonly TransportKind[],
  preferred: TransportKind,
): readonly TransportKind[] {
  if (!transports.includes(preferred)) return transports;
  return [
    preferred,
    ...transports.filter((transport) => transport !== preferred),
  ];
}

function hasCdpSessionParams(params: Record<string, unknown>): boolean {
  return (
    (typeof params.port === "number" && Number.isFinite(params.port)) ||
    typeof params.webSocketDebuggerUrl === "string"
  );
}

function transportForStableRef(stable: string): TransportKind | undefined {
  if (stable.startsWith("cdp-browser:") || stable.startsWith("cdp:")) {
    return "cdp-browser";
  }
  if (stable.startsWith("desktop-uia:")) return "desktop-uia";
  if (stable.startsWith("desktop-atspi:")) return "desktop-atspi";
  if (stable.startsWith("desktop-ax:")) return "desktop-ax";
  return undefined;
}

function readStableRefParam(value: unknown): string {
  return typeof value === "string" ? value : "";
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
  const canMutate = normalizedReq.canMutate === true;
  if (normalizedReq.kind === "compute_find") {
    const result = findInRefStore(bus, normalizedReq.params);
    signal?.throwIfAborted();
    return result;
  }
  const refError = validatePreparedRef(bus, prepared);
  if (refError) return refError;

  const order = preferenceForRequest(prepared, platform);
  if (order.length === 0) {
    return withRemedy(
      err({
        transport: "visual",
        step: 0,
        action: normalizedReq.kind,
        reason: `no transport advertises step ${normalizedReq.kind}`,
        suggestion: `add a row to COMPUTE_PREFERENCE for ${normalizedReq.kind}`,
        minimum_capability: `unknown.${normalizedReq.kind}`,
        exit_code: exitCodeFor("config"),
      }),
    );
  }

  const failures: string[] = [];
  for (const kind of order) {
    signal?.throwIfAborted();
    const staleBeforeOpen = validatePreparedRef(bus, prepared);
    if (staleBeforeOpen) return staleBeforeOpen;
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
      if (staleAfterOpen) return staleAfterOpen;
      if (
        normalizedReq.kind === "compute_snapshot" &&
        (kind === "desktop-uia" ||
          kind === "desktop-atspi" ||
          kind === "cdp-browser")
      ) {
        const snapshot = await adapter.snapshot({
          format: readSnapshotFormat(normalizedReq.params),
          ...(signal ? { signal } : {}),
        });
        signal?.throwIfAborted();
        return ok(enrichSnapshotWithRefProvenance(bus, snapshot, kind));
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
          ...(signal ? { signal } : {}),
        });
        signal?.throwIfAborted();
        return ok(enrichSnapshotWithRefProvenance(bus, snapshot, kind));
      }
      if (result.ok) return result;
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
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${kind}:${message}`);
    }
  }

  return withRemedy(
    err({
      transport: order[0] ?? "visual",
      step: 0,
      action: normalizedReq.kind,
      reason: `all transports failed: ${failures.join("; ")}`,
      suggestion: "inspect each transport: unicli doctor compute",
      minimum_capability: `compute.${normalizedReq.kind}.no-transport-available`,
      exit_code: exitCodeFor("service_unavailable"),
    }),
  );
}

export function prepareComputeRequest(
  bus: TransportBus,
  req: ActionRequest,
): ComputeRequestPreparation {
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

  const matches = bus.refs.matches(refValue);
  if (matches.length > 1) {
    return {
      status: "rejected",
      result: refAmbiguous(req.kind, refValue, matches),
    };
  }
  const refMatch = matches[0];
  if (!refMatch) {
    if (transportForStableRef(refValue)) {
      return { status: "ready", prepared: { request: normalizedReq } };
    }
    if (bus.refs.buckets().length === 0) {
      if (noStoreRefPassthrough.has(bus)) {
        return { status: "ready", prepared: { request: normalizedReq } };
      }
      if (!isPersistedAliasRef(refValue)) {
        noStoreRefPassthrough.add(bus);
        return { status: "ready", prepared: { request: normalizedReq } };
      }
    }
    return {
      status: "rejected",
      result: refExpired(req.kind, refValue, "no live ref matched the target"),
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

function normalizeComputeRequest(req: ActionRequest): ActionRequest {
  if (!FOCUS_NORMALIZED_COMPUTE_STEPS.has(req.kind)) return req;
  if (req.params.focus === true) return req;
  return {
    ...req,
    params: {
      ...req.params,
      focus: false,
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

function isPersistedAliasRef(ref: string): boolean {
  const match = /^@e(\d+)$/.exec(ref);
  if (!match) return false;
  const aliasNumber = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(aliasNumber) && aliasNumber >= 50;
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
        "pass one stable ref from the intended app, or take a fresh snapshot scoped by app or pid",
      minimum_capability: `compute.${action}.ref_ambiguous`,
      exit_code: exitCodeFor("empty_result"),
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
    return roleMatches && nameMatches && textMatches;
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
  const matches = bus.refs.matches(refValue);
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
      ...(ref.app ? { app: ref.app } : {}),
      role: ref.role,
      ...(ref.name ? { title: ref.name, name: ref.name } : {}),
      stable: ref.stable,
      ...req.params,
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
