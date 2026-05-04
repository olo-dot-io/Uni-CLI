import { err, exitCodeFor, ok } from "../core/envelope.js";
import { enrichErrorWithRemedy } from "../engine/repair/remedies.js";
import type { ElementRef, RefBucket } from "./refs.js";
import type {
  ActionRequest,
  ActionResult,
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
    "cua",
  ],
  compute_find: [
    "desktop-ax",
    "desktop-uia",
    "desktop-atspi",
    "cdp-browser",
    "cua",
  ],
  compute_screenshot: [
    "cdp-browser",
    "desktop-ax",
    "desktop-uia",
    "desktop-atspi",
    "cua",
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
    "cua",
    "subprocess",
  ],
  compute_assert: [
    "desktop-ax",
    "cdp-browser",
    "desktop-uia",
    "desktop-atspi",
    "cua",
    "subprocess",
  ],
  compute_click: [
    "desktop-ax",
    "cdp-browser",
    "desktop-uia",
    "desktop-atspi",
    "cua",
  ],
  compute_type: [
    "desktop-ax",
    "cdp-browser",
    "desktop-uia",
    "desktop-atspi",
    "cua",
  ],
  compute_press: [
    "desktop-ax",
    "cdp-browser",
    "desktop-uia",
    "desktop-atspi",
    "cua",
  ],
  compute_scroll: [
    "desktop-ax",
    "cdp-browser",
    "desktop-uia",
    "desktop-atspi",
    "cua",
  ],
  compute_launch: ["subprocess", "desktop-ax", "desktop-uia", "desktop-atspi"],
  compute_cdp_attach: ["cdp-browser"],
  compute_evaluate: ["cdp-browser"],
};

const MUTATING_COMPUTE_STEPS = new Set([
  "compute_click",
  "compute_type",
  "compute_press",
  "compute_scroll",
]);

const noStoreRefPassthrough = new WeakSet<TransportBus>();

const DEFAULT_REF_TTL_MS = 60 * 60 * 1000;

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
  bus: TransportBus,
  req: ActionRequest,
  platform: NodeJS.Platform,
): readonly TransportKind[] {
  const base = preferenceFor(req.kind, platform);
  const ref = resolveParamRef(bus, req.params.ref);
  const owner = transportForStableRef(
    ref?.stable ?? readStableRefParam(req.params.ref),
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
): Promise<ActionResult<unknown>> {
  const normalizedReq = normalizeComputeRequest(req);
  if (normalizedReq.kind === "compute_find") {
    return findInRefStore(bus, normalizedReq.params);
  }
  const refError = validateRequestRef(bus, normalizedReq);
  if (refError) return refError;

  const order = preferenceForRequest(bus, normalizedReq, platform);
  if (order.length === 0) {
    return withRemedy(
      err({
        transport: "cua",
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
    try {
      const adapter = bus.get(kind);
      const adapted = adaptStep(enrichFromRef(bus, normalizedReq), kind);
      const dispatchReq = normalizeFocusForTransport(
        adapted,
        kind,
        normalizedReq.kind,
      );
      await adapter.open(transportCtx);
      const result = await adapter.action<unknown>(dispatchReq);
      if (
        result.ok &&
        normalizedReq.kind === "compute_snapshot" &&
        (kind === "desktop-ax" ||
          kind === "desktop-uia" ||
          kind === "desktop-atspi" ||
          kind === "cdp-browser")
      ) {
        const snapshot = await adapter.snapshot({
          format: readSnapshotFormat(normalizedReq.params),
        });
        return ok(snapshot);
      }
      if (result.ok) return result;
      failures.push(
        `${kind}:${result.error.minimum_capability ?? result.error.reason}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${kind}:${message}`);
    }
  }

  return withRemedy(
    err({
      transport: order[0] ?? "cua",
      step: 0,
      action: normalizedReq.kind,
      reason: `all transports failed: ${failures.join("; ")}`,
      suggestion: "inspect each transport: unicli doctor compute",
      minimum_capability: `compute.${normalizedReq.kind}.no-transport-available`,
      exit_code: exitCodeFor("service_unavailable"),
    }),
  );
}

function normalizeComputeRequest(req: ActionRequest): ActionRequest {
  if (!MUTATING_COMPUTE_STEPS.has(req.kind)) return req;
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
  if (transport !== "cua" || !MUTATING_COMPUTE_STEPS.has(computeKind)) {
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

function validateRequestRef(
  bus: TransportBus,
  req: ActionRequest,
): ActionResult<unknown> | undefined {
  const refValue = req.params.ref;
  if (typeof refValue !== "string" || refValue.length === 0) return undefined;
  const resolved = resolveParamRefWithBucket(bus, refValue);
  if (!resolved) {
    if (transportForStableRef(refValue)) return undefined;
    if (bus.refs.buckets().length === 0) {
      if (noStoreRefPassthrough.has(bus)) return undefined;
      if (!isPersistedAliasRef(refValue)) {
        noStoreRefPassthrough.add(bus);
        return undefined;
      }
    }
    return refExpired(req.kind, refValue, "no live ref matched the target");
  }
  if (isRefBucketExpired(resolved.bucket)) {
    return refExpired(
      req.kind,
      refValue,
      `ref ${refValue} expired; bucket age ${Date.now() - resolved.bucket.createdAt}ms exceeds ${readRefTtlMs()}ms`,
    );
  }
  if (isDisabledRef(resolved.ref)) {
    return elementDisabled(req.kind, refValue, resolved.ref);
  }
  if (isOffScreenRef(resolved.ref)) {
    return elementOffScreen(req.kind, refValue, resolved.ref);
  }
  if (isMinimizedRef(resolved.ref)) {
    return windowMinimized(req.kind, refValue, resolved.ref);
  }
  return undefined;
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
      transport: "cua",
      step: 0,
      action,
      reason: `${reason}: ${ref}`,
      suggestion: "run `unicli compute snapshot` again, then retry",
      minimum_capability: `compute.${action}.ref_expired`,
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
      transport: "cua",
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
      transport: "cua",
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
      transport: "cua",
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

function findInRefStore(
  bus: TransportBus,
  params: Record<string, unknown>,
): ActionResult<unknown> {
  const role = typeof params.role === "string" ? simplifyRole(params.role) : "";
  const name = typeof params.name === "string" ? params.name.toLowerCase() : "";
  const text = typeof params.text === "string" ? params.text.toLowerCase() : "";
  const matches = bus.refs.list().filter((ref) => {
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
    return first ? ok(first) : findEmpty(params);
  }
  return ok(matches);
}

function isAmbiguousFind(
  matches: readonly ElementRef[],
  params: Record<string, unknown>,
): boolean {
  if (matches.length < 2) return false;
  if (typeof params.pid === "number" || typeof params.windowId === "string") {
    return false;
  }
  const scopes = new Set(
    matches.map((ref) => `${ref.app ?? ""}:${ref.pid ?? ""}:${scopeOf(ref)}`),
  );
  return scopes.size > 1;
}

function scopeOf(ref: ElementRef): string {
  const stableParts = ref.stable.split(":");
  return stableParts.length >= 3 ? (stableParts[1] ?? "") : "";
}

function findAmbiguous(
  matches: readonly ElementRef[],
  params: Record<string, unknown>,
): ActionResult<unknown> {
  return withRemedy(
    err({
      transport: "cua",
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
      transport: "cua",
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

function resolveParamRef(
  bus: TransportBus,
  refValue: unknown,
): ReturnType<TransportBus["refs"]["resolve"]> {
  return resolveParamRefWithBucket(bus, refValue)?.ref;
}

function resolveParamRefWithBucket(
  bus: TransportBus,
  refValue: unknown,
): { ref: ElementRef; bucket: RefBucket } | undefined {
  if (typeof refValue !== "string") return undefined;
  for (const bucket of bus.refs.buckets()) {
    const ref = bucket.byAlias.get(refValue) ?? bucket.byStable.get(refValue);
    if (ref) return { ref, bucket };
  }
  return undefined;
}

function enrichFromRef(bus: TransportBus, req: ActionRequest): ActionRequest {
  const refValue = req.params.ref;
  const ref = resolveParamRef(bus, refValue);
  if (!ref) return req;

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
    compute_press: "ax_press",
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
  cua: {
    compute_snapshot: "cua_snapshot",
    compute_click: "cua_click",
    compute_type: "cua_type",
    compute_press: "cua_key",
    compute_scroll: "cua_scroll",
    compute_screenshot: "cua_snapshot",
    compute_wait: "cua_wait",
  },
  subprocess: {
    compute_apps: "exec",
    compute_launch: "launch_app",
    compute_wait: "wait",
  },
};
