/**
 * @owner       src::transport::routing
 * @does        Compile compute provider profiles and select one task-compatible provider before any provider is opened.
 * @needs       compute target/ref helpers and transport kinds
 * @feeds       compute dispatch, route explanation, conformance tests, and performance checks
 * @breaks      An incorrect route can act on the wrong surface or silently escalate from semantic control to pixels.
 * @invariants  Exact ref ownership dominates implicit selection; visual action is explicit; one decision names one provider and one physical action; provider failure never changes the decision.
 * @side-effects None.
 * @perf        O(1) provider lookup plus O(k) explanation over providers that implement one action, where k <= 6.
 * @concurrency Immutable indexes and pure decisions are safe across requests.
 * @test        tests/unit/transport/routing.test.ts, tests/unit/compute-dispatch.test.ts
 * @stability   experimental
 * @since       2026-07-30
 */

import {
  hasCdpTarget,
  readComputeTargetApp,
  transportForComputeRef,
} from "../compute/wait.js";
import type {
  ActuationModality,
  ExecutionOperator,
  OperatorTargetScope,
  PerceptionModality,
} from "../types.js";
import type { ActionRequest, TransportKind } from "./types.js";
import {
  NO_AUTOMATIC_RECOVERY,
  SAFE_READ_RECOVERY,
  type RecoveryPolicy,
} from "../core/recovery.js";

export type ComputeRouteName =
  | "native"
  | "browser"
  | "process"
  | "driver"
  | "visual";

export interface ComputeProviderProfile {
  readonly transport: TransportKind;
  readonly route: ComputeRouteName;
  readonly operator: ExecutionOperator;
  readonly perception: PerceptionModality;
  readonly actuation: ActuationModality;
  readonly target_scope: OperatorTargetScope;
  readonly verification: ComputeVerification;
  readonly interaction_impact: ComputeInteractionImpact;
  readonly platforms?: readonly ("darwin" | "win32" | "linux")[];
  readonly implicit: boolean;
  readonly actions: Readonly<Record<string, ComputeActionBinding>>;
}

export interface ComputeActionBinding {
  readonly physical_action: string;
  readonly operator?: ExecutionOperator;
  readonly perception?: PerceptionModality;
  readonly actuation?: ActuationModality;
  readonly target_scope?: OperatorTargetScope;
  readonly verification?: ComputeVerification;
  readonly interaction_impact?: ComputeInteractionImpact;
  readonly recovery?: RecoveryPolicy;
}

export interface ComputeRouteSelection {
  transport: TransportKind;
  route: ComputeRouteName;
  operator: ExecutionOperator;
  perception: PerceptionModality;
  actuation: ActuationModality;
  target_scope: OperatorTargetScope;
  verification: ComputeVerification;
  interaction_impact: ComputeInteractionImpact;
  physical_action: string;
  reason: string;
  explicit: boolean;
  evidence_transport?: TransportKind;
  recovery: RecoveryPolicy;
}

export interface ComputeRouteCandidate {
  transport: TransportKind;
  route: ComputeRouteName;
  operator: ExecutionOperator;
  perception: PerceptionModality;
  actuation: ActuationModality;
  target_scope: OperatorTargetScope;
  physical_action: string;
  verification: ComputeVerification;
  interaction_impact: ComputeInteractionImpact;
  automatic: boolean;
  feasible: boolean;
  selected: boolean;
  reason: string;
  recovery: RecoveryPolicy;
}

export type ComputeVerification =
  | "process-result"
  | "dom-state"
  | "accessibility-state"
  | "pixel-observation"
  | "provider-effect"
  | "local-result";

export type ComputeInteractionImpact =
  | "background"
  | "target-scoped"
  | "foreground";

export type ComputeRouteDecision =
  | {
      status: "selected";
      action: string;
      requested_via?: ComputeRouteName;
      selection: ComputeRouteSelection;
      candidates: ComputeRouteCandidate[];
    }
  | {
      status: "unavailable";
      action: string;
      requested_via?: string;
      reason: string;
      suggestion: string;
      candidates: ComputeRouteCandidate[];
    };

const NATIVE_BY_PLATFORM: Readonly<
  Partial<Record<NodeJS.Platform, TransportKind>>
> = {
  darwin: "desktop-ax",
  win32: "desktop-uia",
  linux: "desktop-atspi",
};

const DEFAULT_ROUTE_BY_ACTION: Readonly<
  Record<string, ComputeRouteName | undefined>
> = {
  compute_apps: "native",
  compute_windows: "native",
  compute_snapshot: "native",
  compute_click: "native",
  compute_type: "native",
  compute_press: "native",
  compute_scroll: "native",
  compute_launch: "process",
  compute_screenshot: "native",
  compute_cdp_attach: "browser",
  compute_evaluate: "browser",
  compute_assert: "native",
};

const DRIVER_DIRECT_ACTIONS = new Set([
  "compute_session_start",
  "compute_session_state",
  "compute_session_escalate",
  "compute_session_end",
  "compute_screen_size",
  "compute_cursor_position",
  "compute_agent_cursor_state",
  "compute_agent_cursor_enabled",
  "compute_agent_cursor_motion",
  "compute_agent_cursor_theme",
]);

function perform(
  physicalAction: string,
  overrides: Omit<ComputeActionBinding, "physical_action"> = {},
): ComputeActionBinding {
  return {
    physical_action: physicalAction,
    recovery: NO_AUTOMATIC_RECOVERY,
    ...overrides,
  };
}

function observe(
  physicalAction: string,
  overrides: Omit<ComputeActionBinding, "physical_action"> = {},
): ComputeActionBinding {
  return {
    physical_action: physicalAction,
    actuation: "none",
    recovery: SAFE_READ_RECOVERY,
    ...overrides,
  };
}

function capture(
  physicalAction: string,
  overrides: Omit<ComputeActionBinding, "physical_action"> = {},
): ComputeActionBinding {
  return {
    physical_action: physicalAction,
    operator: "visual-observation",
    perception: "pixels",
    actuation: "screen-capture",
    verification: "pixel-observation",
    recovery: SAFE_READ_RECOVERY,
    ...overrides,
  };
}

function sessionMutation(physicalAction: string): ComputeActionBinding {
  return perform(physicalAction, {
    operator: "local-runtime",
    perception: "local-state",
    actuation: "protocol-call",
    target_scope: "local-runtime",
    verification: "local-result",
    interaction_impact: "background",
  });
}

function sessionRead(physicalAction: string): ComputeActionBinding {
  return observe(physicalAction, {
    operator: "local-runtime",
    perception: "local-state",
    target_scope: "local-runtime",
    verification: "local-result",
    interaction_impact: "background",
  });
}

export const COMPUTE_PROVIDER_PROFILES: readonly ComputeProviderProfile[] = [
  {
    transport: "desktop-ax",
    route: "native",
    operator: "desktop-accessibility",
    perception: "os-accessibility",
    actuation: "accessibility-action",
    target_scope: "native-window",
    verification: "accessibility-state",
    interaction_impact: "target-scoped",
    platforms: ["darwin"],
    implicit: true,
    actions: {
      compute_apps: observe("ax_apps"),
      compute_windows: observe("ax_windows"),
      compute_snapshot: observe("ax_snapshot"),
      compute_click: perform("ax_press"),
      compute_type: perform("ax_set_value"),
      compute_press: perform("ax_background_press", {
        actuation: "desktop-input",
      }),
      compute_scroll: perform("ax_scroll"),
      compute_screenshot: capture("ax_screenshot"),
    },
  },
  {
    transport: "desktop-uia",
    route: "native",
    operator: "desktop-accessibility",
    perception: "os-accessibility",
    actuation: "accessibility-action",
    target_scope: "native-window",
    verification: "accessibility-state",
    interaction_impact: "target-scoped",
    platforms: ["win32"],
    implicit: true,
    actions: {
      compute_apps: observe("uia_apps"),
      compute_windows: observe("uia_windows"),
      compute_snapshot: observe("uia_snapshot"),
      compute_click: perform("uia_invoke"),
      compute_type: perform("uia_set_value"),
      compute_press: perform("uia_press", {
        actuation: "desktop-input",
      }),
      compute_scroll: perform("uia_scroll"),
      compute_screenshot: capture("uia_screenshot"),
      compute_wait: observe("uia_wait"),
    },
  },
  {
    transport: "desktop-atspi",
    route: "native",
    operator: "desktop-accessibility",
    perception: "os-accessibility",
    actuation: "accessibility-action",
    target_scope: "native-window",
    verification: "accessibility-state",
    interaction_impact: "target-scoped",
    platforms: ["linux"],
    implicit: true,
    actions: {
      compute_apps: observe("atspi_apps"),
      compute_windows: observe("atspi_windows"),
      compute_snapshot: observe("atspi_snapshot"),
      compute_click: perform("atspi_invoke"),
      compute_type: perform("atspi_set_value"),
      compute_press: perform("atspi_press", {
        actuation: "desktop-input",
        target_scope: "desktop",
        interaction_impact: "foreground",
      }),
      compute_scroll: perform("atspi_scroll"),
      compute_screenshot: capture("atspi_screenshot"),
      compute_wait: observe("atspi_wait"),
    },
  },
  {
    transport: "cdp-browser",
    route: "browser",
    operator: "browser-semantic",
    perception: "dom-accessibility",
    actuation: "dom-action",
    target_scope: "browser-renderer",
    verification: "dom-state",
    interaction_impact: "background",
    implicit: true,
    actions: {
      compute_snapshot: observe("snapshot"),
      compute_click: perform("click"),
      compute_type: perform("type"),
      compute_press: perform("press"),
      compute_scroll: perform("scroll"),
      compute_screenshot: capture("screenshot"),
      compute_cdp_attach: perform("cdp_attach"),
      compute_evaluate: perform("evaluate"),
      compute_wait: observe("wait"),
    },
  },
  {
    transport: "subprocess",
    route: "process",
    operator: "native-cli",
    perception: "process-output",
    actuation: "process-call",
    target_scope: "host-process",
    verification: "process-result",
    interaction_impact: "background",
    implicit: true,
    actions: {
      compute_launch: perform("launch_app"),
    },
  },
  {
    transport: "cua-driver",
    route: "driver",
    operator: "visual-coordinate",
    perception: "pixels",
    actuation: "coordinate-action",
    target_scope: "desktop",
    verification: "provider-effect",
    interaction_impact: "foreground",
    implicit: false,
    actions: {
      compute_point_click: perform("cua_click"),
      compute_drag: perform("cua_drag"),
      compute_text: perform("cua_type_text"),
      compute_press: perform("cua_press"),
      compute_point_scroll: perform("cua_scroll"),
      compute_screenshot: capture("cua_get_desktop_state", {
        interaction_impact: "background",
      }),
      compute_screen_size: sessionRead("cua_get_screen_size"),
      compute_cursor_position: sessionRead("cua_get_cursor_position"),
      compute_move_cursor: perform("cua_move_cursor"),
      compute_session_start: sessionMutation("cua_start_session"),
      compute_session_state: sessionRead("cua_get_session_state"),
      compute_session_escalate: sessionMutation("cua_escalate_session"),
      compute_session_end: sessionMutation("cua_end_session"),
      compute_agent_cursor_state: sessionRead("cua_get_agent_cursor_state"),
      compute_agent_cursor_enabled: sessionMutation(
        "cua_set_agent_cursor_enabled",
      ),
      compute_agent_cursor_motion: sessionMutation(
        "cua_set_agent_cursor_motion",
      ),
      compute_agent_cursor_theme: sessionMutation("cua_set_agent_cursor_theme"),
    },
  },
  {
    transport: "visual",
    route: "visual",
    operator: "visual-coordinate",
    perception: "pixels",
    actuation: "coordinate-action",
    target_scope: "desktop",
    verification: "pixel-observation",
    interaction_impact: "foreground",
    implicit: false,
    actions: {
      compute_click: perform("visual_click"),
      compute_point_click: perform("visual_click"),
      compute_drag: perform("visual_drag"),
      compute_type: perform("visual_type"),
      compute_text: perform("visual_type"),
      compute_press: perform("visual_key"),
      compute_scroll: perform("visual_scroll"),
      compute_screenshot: capture("visual_snapshot"),
      compute_wait: observe("visual_wait"),
    },
  },
] as const;

const PROFILE_BY_TRANSPORT = new Map(
  COMPUTE_PROVIDER_PROFILES.map((profile) => [profile.transport, profile]),
);

const PROFILES_BY_ACTION = compileProfilesByAction(COMPUTE_PROVIDER_PROFILES);

export function computeProviderProfile(
  transport: TransportKind,
): ComputeProviderProfile | undefined {
  return PROFILE_BY_TRANSPORT.get(transport);
}

export function computePhysicalAction(
  transport: TransportKind,
  logicalAction: string,
): string | undefined {
  return PROFILE_BY_TRANSPORT.get(transport)?.actions[logicalAction]
    ?.physical_action;
}

export function planComputeRoute(
  req: ActionRequest,
  platform: NodeJS.Platform = process.platform,
  refOwner?: TransportKind,
): ComputeRouteDecision {
  const requestedRaw = readRequestedVia(req.params);
  const requested = normalizeRequestedVia(requestedRaw);
  if (requestedRaw !== undefined && requested === undefined) {
    return unavailable(
      req,
      String(requestedRaw),
      `unknown compute route ${JSON.stringify(requestedRaw)}`,
      "use native, browser, process, driver, or visual",
      platform,
    );
  }

  const stableOwner =
    refOwner ??
    readStableRefOwner(req.params.stable) ??
    readStableRefOwner(req.params.ref);

  if (requested) {
    const transport = transportForRoute(requested, platform);
    if (!transport) {
      return unavailable(
        req,
        requested,
        `route ${requested} has no provider on platform ${platform}`,
        "choose a provider supported on this host",
        platform,
        stableOwner,
      );
    }
    const evidenceTransport =
      requested === "visual" &&
      stableOwner &&
      canUseRefAsVisualEvidence(req, stableOwner)
        ? stableOwner
        : undefined;
    return selected(
      req,
      requested,
      transport,
      evidenceTransport
        ? "explicit visual action using fresh ref bounds as perception evidence"
        : `explicit ${requested} route`,
      true,
      platform,
      stableOwner,
      evidenceTransport,
    );
  }

  if (stableOwner) {
    return selected(
      req,
      undefined,
      stableOwner,
      "exact ref owner",
      false,
      platform,
      stableOwner,
    );
  }

  if (req.kind === "compute_cdp_attach" || req.kind === "compute_evaluate") {
    return selected(
      req,
      undefined,
      "cdp-browser",
      "operation is defined on one browser renderer",
      false,
      platform,
    );
  }
  if (req.kind === "compute_launch") {
    return selected(
      req,
      undefined,
      "subprocess",
      "launch is a process operation",
      false,
      platform,
    );
  }
  if (DRIVER_DIRECT_ACTIONS.has(req.kind)) {
    return selected(
      req,
      "driver",
      "cua-driver",
      "the operation explicitly names the Cua Driver protocol capability",
      true,
      platform,
    );
  }
  if (hasCdpTarget(req.params) || hasBrowserSelector(req.params)) {
    return selected(
      req,
      undefined,
      "cdp-browser",
      hasCdpTarget(req.params)
        ? "exact CDP renderer target"
        : "browser selector requires semantic DOM execution",
      false,
      platform,
    );
  }

  const defaultRoute = DEFAULT_ROUTE_BY_ACTION[req.kind];
  if (defaultRoute) {
    const transport = transportForRoute(defaultRoute, platform);
    if (transport) {
      const reason =
        readComputeTargetApp(req.params) !== undefined
          ? "explicit native app target"
          : `compute ${req.kind.slice("compute_".length)} defaults to the ${defaultRoute} operator`;
      return selected(req, undefined, transport, reason, false, platform);
    }
  }

  return unavailable(
    req,
    undefined,
    `no implicit provider is defined for ${req.kind}`,
    "bind an exact ref/target or select an explicit route",
    platform,
  );
}

export function adaptComputeAction(
  req: ActionRequest,
  selection: ComputeRouteSelection,
): ActionRequest {
  const { via: _via, ...params } = req.params;
  return {
    ...req,
    kind: selection.physical_action,
    params,
  };
}

function actionTargetScope(
  req: ActionRequest,
  profile: ComputeProviderProfile,
  binding: ComputeActionBinding,
): OperatorTargetScope {
  if (
    req.kind === "compute_screenshot" &&
    profile.route === "native" &&
    readComputeTargetApp(req.params) === undefined &&
    req.params.windowId === undefined &&
    req.params.ref === undefined &&
    req.params.stable === undefined
  ) {
    return "desktop";
  }
  return binding.target_scope ?? profile.target_scope;
}

function selected(
  req: ActionRequest,
  requestedVia: ComputeRouteName | undefined,
  transport: TransportKind,
  reason: string,
  explicit: boolean,
  platform: NodeJS.Platform,
  stableOwner?: TransportKind,
  evidenceTransport?: TransportKind,
): ComputeRouteDecision {
  const action = req.kind;
  const profile = PROFILE_BY_TRANSPORT.get(transport);
  const binding = profile?.actions[action];
  if (!profile || !binding || !supportsPlatform(profile, platform)) {
    return unavailable(
      req,
      requestedVia,
      `provider ${transport} does not implement ${action} on ${platform}`,
      "bind a compatible target or choose another explicit route",
      platform,
      stableOwner,
    );
  }
  const conflict = routeEvidenceConflict(
    req,
    transport,
    stableOwner,
    evidenceTransport,
  );
  if (conflict) {
    return unavailable(
      req,
      requestedVia,
      conflict.reason,
      conflict.suggestion,
      platform,
      stableOwner,
    );
  }
  const selection: ComputeRouteSelection = {
    transport,
    route: profile.route,
    operator: binding.operator ?? profile.operator,
    perception: binding.perception ?? profile.perception,
    actuation: binding.actuation ?? profile.actuation,
    target_scope: actionTargetScope(req, profile, binding),
    verification: binding.verification ?? profile.verification,
    interaction_impact:
      binding.interaction_impact ?? profile.interaction_impact,
    physical_action: binding.physical_action,
    recovery: bindingRecovery(req, binding),
    reason,
    explicit,
    ...(evidenceTransport ? { evidence_transport: evidenceTransport } : {}),
  };
  return {
    status: "selected",
    action,
    ...(requestedVia ? { requested_via: requestedVia } : {}),
    selection,
    candidates: explainCandidates(req, platform, selection, stableOwner),
  };
}

function unavailable(
  req: ActionRequest,
  requestedVia: string | undefined,
  reason: string,
  suggestion: string,
  platform: NodeJS.Platform,
  stableOwner?: TransportKind,
): ComputeRouteDecision {
  return {
    status: "unavailable",
    action: req.kind,
    ...(requestedVia ? { requested_via: requestedVia } : {}),
    reason,
    suggestion,
    candidates: explainCandidates(req, platform, undefined, stableOwner),
  };
}

function explainCandidates(
  req: ActionRequest,
  platform: NodeJS.Platform,
  selection?: ComputeRouteSelection,
  stableOwner?: TransportKind,
): ComputeRouteCandidate[] {
  const action = req.kind;
  return (PROFILES_BY_ACTION.get(action) ?? [])
    .filter((profile) => supportsPlatform(profile, platform))
    .map((profile) => {
      const isSelected = selection?.transport === profile.transport;
      const binding = profile.actions[action];
      if (!binding) {
        throw new Error(
          `compiled provider ${profile.transport} is missing ${action}`,
        );
      }
      const conflict = routeEvidenceConflict(
        req,
        profile.transport,
        stableOwner,
        selection?.evidence_transport,
      );
      return {
        transport: profile.transport,
        route: profile.route,
        operator: binding.operator ?? profile.operator,
        perception: binding.perception ?? profile.perception,
        actuation: binding.actuation ?? profile.actuation,
        target_scope: actionTargetScope(req, profile, binding),
        physical_action: binding.physical_action,
        verification: binding.verification ?? profile.verification,
        interaction_impact:
          binding.interaction_impact ?? profile.interaction_impact,
        automatic: profile.implicit,
        feasible: conflict === undefined,
        selected: isSelected,
        reason: isSelected
          ? selection.reason
          : conflict
            ? conflict.reason
            : profile.implicit
              ? "compatible provider; not selected by target evidence"
              : `requires explicit ${profile.route} route`,
        recovery: bindingRecovery(req, binding),
      };
    });
}

function transportForRoute(
  route: ComputeRouteName,
  platform: NodeJS.Platform,
): TransportKind | undefined {
  if (route === "native") return NATIVE_BY_PLATFORM[platform];
  if (route === "browser") return "cdp-browser";
  if (route === "process") return "subprocess";
  if (route === "driver") return "cua-driver";
  return "visual";
}

function normalizeRequestedVia(value: unknown): ComputeRouteName | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  switch (value.trim().toLowerCase()) {
    case "native":
    case "desktop":
    case "accessibility":
    case "desktop-ax":
    case "desktop-uia":
    case "desktop-atspi":
      return "native";
    case "browser":
    case "cdp":
    case "cdp-browser":
      return "browser";
    case "process":
    case "subprocess":
    case "cli":
      return "process";
    case "driver":
    case "cua":
    case "cua-driver":
    case "os-driver":
      return "driver";
    case "visual":
    case "pixel":
    case "coordinates":
      return "visual";
    default:
      return undefined;
  }
}

function readRequestedVia(params: Readonly<Record<string, unknown>>): unknown {
  return params.via;
}

function readStableRefOwner(value: unknown): TransportKind | undefined {
  return typeof value === "string" ? transportForComputeRef(value) : undefined;
}

function hasBrowserSelector(
  params: Readonly<Record<string, unknown>>,
): boolean {
  return (
    typeof params.selector === "string" && params.selector.trim().length > 0
  );
}

function canUseRefAsVisualEvidence(
  req: ActionRequest,
  owner: TransportKind,
): boolean {
  return (
    owner !== "visual" &&
    req.kind === "compute_click" &&
    isFiniteNumber(req.params.x) &&
    isFiniteNumber(req.params.y)
  );
}

function routeEvidenceConflict(
  req: ActionRequest,
  transport: TransportKind,
  stableOwner?: TransportKind,
  evidenceTransport?: TransportKind,
): { reason: string; suggestion: string } | undefined {
  if (stableOwner && stableOwner !== transport) {
    if (
      transport === "visual" &&
      evidenceTransport === stableOwner &&
      canUseRefAsVisualEvidence(req, stableOwner)
    ) {
      return undefined;
    }
    return {
      reason: `ref owner ${stableOwner} conflicts with requested provider ${transport}`,
      suggestion:
        "use the ref owner or take fresh perception evidence for the requested provider",
    };
  }

  const browserEvidence =
    hasCdpTarget(req.params) || hasBrowserSelector(req.params);
  const app = readComputeTargetApp(req.params);
  const nativeWindowEvidence =
    req.params.pid !== undefined || req.params.windowId !== undefined;

  if (
    transport === "desktop-ax" &&
    req.kind === "compute_snapshot" &&
    app === undefined &&
    !nativeWindowEvidence &&
    stableOwner !== "desktop-ax"
  ) {
    return {
      reason:
        "macOS accessibility snapshot requires an exact app, window, or AX-owned ref target",
      suggestion:
        "pass --app/--window-id, reuse an AX ref, or explicitly select browser for a renderer target",
    };
  }

  if (isNativeTransport(transport) && browserEvidence) {
    return {
      reason: `browser target evidence conflicts with requested provider ${transport}`,
      suggestion:
        "use the browser route for CDP/DOM targets, or remove the browser-only target fields",
    };
  }

  if (transport === "cdp-browser") {
    if (nativeWindowEvidence) {
      return {
        reason:
          "native pid/window target evidence conflicts with the browser renderer provider",
        suggestion:
          "bind the browser route with an exact CDP endpoint/ref, or use the native route for the OS window",
      };
    }
    if (
      app &&
      req.kind !== "compute_cdp_attach" &&
      !hasCdpTarget(req.params) &&
      stableOwner !== "cdp-browser"
    ) {
      return {
        reason: `app target ${JSON.stringify(app)} does not identify a CDP renderer for ${req.kind}`,
        suggestion:
          "attach the Electron app first and reuse its exact CDP target, or use the native route",
      };
    }
  }

  if (
    transport === "subprocess" &&
    (browserEvidence || stableOwner !== undefined)
  ) {
    return {
      reason:
        "element or renderer target evidence conflicts with a process operation",
      suggestion:
        "remove element/renderer fields for process launch, or select the target-owning route",
    };
  }

  if (
    (transport === "visual" || transport === "cua-driver") &&
    (browserEvidence || app !== undefined || nativeWindowEvidence)
  ) {
    return {
      reason: `the ${transport} provider is desktop-scoped and cannot honor an app, window, or renderer target`,
      suggestion:
        "bring the intended surface to the foreground separately, take fresh pixels, then issue an explicit coordinate action without ignored target fields",
    };
  }
  if (transport === "visual" && req.params.session !== undefined) {
    return {
      reason: "Cua Driver session identity cannot be honored by visual",
      suggestion:
        "remove session for the visual provider or explicitly select the driver route",
    };
  }
  if (
    transport === "visual" &&
    req.kind === "compute_screenshot" &&
    typeof req.params.path === "string" &&
    req.params.path.trim().length > 0
  ) {
    return {
      reason: "the visual backend does not implement screenshot file writes",
      suggestion:
        "omit path to receive pixels inline, or select native/driver for an explicit file artifact",
    };
  }

  return undefined;
}

function isNativeTransport(transport: TransportKind): boolean {
  return (
    transport === "desktop-ax" ||
    transport === "desktop-uia" ||
    transport === "desktop-atspi"
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function bindingRecovery(
  req: ActionRequest,
  binding: ComputeActionBinding,
): RecoveryPolicy {
  return req.kind === "compute_screenshot" &&
    typeof req.params.path === "string" &&
    req.params.path.trim().length > 0
    ? NO_AUTOMATIC_RECOVERY
    : (binding.recovery ?? NO_AUTOMATIC_RECOVERY);
}

function supportsPlatform(
  profile: ComputeProviderProfile,
  platform: NodeJS.Platform,
): boolean {
  return (
    profile.platforms === undefined ||
    profile.platforms.includes(platform as "darwin" | "win32" | "linux")
  );
}

function compileProfilesByAction(
  profiles: readonly ComputeProviderProfile[],
): ReadonlyMap<string, readonly ComputeProviderProfile[]> {
  const mutable = new Map<string, ComputeProviderProfile[]>();
  for (const profile of profiles) {
    for (const action of Object.keys(profile.actions)) {
      const existing = mutable.get(action);
      if (existing) existing.push(profile);
      else mutable.set(action, [profile]);
    }
  }
  return new Map(
    Array.from(mutable, ([action, providers]) => [
      action,
      Object.freeze([...providers]),
    ]),
  );
}
