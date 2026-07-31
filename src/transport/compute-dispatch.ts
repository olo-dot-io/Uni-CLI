/**
 * @owner       src::transport::compute-dispatch
 * @does        Bind one immutable compute target, select one task-compatible provider, and evaluate condition waits from fresh snapshots.
 * @needs       compute wait/contracts, core envelopes, repair remedies, refs, transport types.
 * @feeds       compute CLI, registered compute pipeline steps, and computer-use action execution.
 * @breaks      Re-resolving a short alias after an await can dispatch against a different app; replaying an ambiguous mutation can duplicate host effects.
 * @invariants  One exact ref generation feeds validation, routing, enrichment, overlay evidence, and dispatch; one route opens one provider; visual action requires an explicit route; ordinary provider failure never changes provider; waits succeed only from an observed condition.
 * @side-effects Opens and dispatches the selected transport adapter and may allocate refs from snapshots.
 * @perf        One-shot actions are O(1 + live ref buckets); condition waits repeat one target snapshot every 50ms until a 300s maximum deadline.
 * @concurrency A bound ref generation is revalidated after every awaited adapter setup before dispatch.
 * @test        tests/unit/compute-dispatch.test.ts, tests/unit/compute-action-execution.test.ts
 * @stability   stable
 * @since       2026-06-29
 */

import { err, exitCodeFor, ok } from "../core/envelope.js";
import { attachDefaultEffectVerdict } from "../core/effect-verdict.js";
import type { RecoveryAttempt, RecoveryTrace } from "../core/recovery.js";
import {
  computeCommandCanMutate,
  COMPUTE_REF_ACCEPTED_NAMESPACES,
  readForeignComputeRefOwner,
  resolveComputeArguments,
} from "../compute/contracts.js";
import { assertComputeRefs } from "../compute/assert.js";
import { observeComputeRefs } from "../compute/observe.js";
import {
  claimVisualObservation,
  issueVisualObservation,
  VisualObservationError,
  type ClaimedVisualObservation,
  type VisualObservationEvidence,
  type VisualObservationPoint,
  type VisualObservationProvider,
} from "../compute/visual-observation.js";
import {
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
import {
  adaptComputeAction,
  planComputeRoute,
  type ComputeRouteDecision,
  type ComputeRouteSelection,
} from "./routing.js";
import type {
  ActionRequest,
  ActionResult,
  Snapshot,
  TransportBus,
  TransportContext,
  TransportKind,
} from "./types.js";

const FOCUS_NORMALIZED_COMPUTE_STEPS = new Set([
  "compute_click",
  "compute_type",
  "compute_press",
  "compute_scroll",
]);

const DEFAULT_REF_TTL_MS = 60 * 60 * 1000;
const COMPUTE_ROUTE_NAMES = new Set([
  "native",
  "browser",
  "process",
  "driver",
  "visual",
]);

export interface PreparedComputeRequest {
  request: ActionRequest;
  refMatch?: RefStoreMatch;
}

export type ComputeRequestPreparation =
  | { status: "ready"; prepared: PreparedComputeRequest }
  | { status: "rejected"; result: ActionResult<unknown> };

export async function dispatchComputeRoute(
  bus: TransportBus,
  req: ActionRequest,
  platform: NodeJS.Platform = process.platform,
  transportCtx: TransportContext = { vars: {}, bus, refs: bus.refs },
  preparedRequest?: PreparedComputeRequest,
): Promise<ActionResult<unknown>> {
  return (
    await dispatchComputeRouteDetailed(
      bus,
      req,
      platform,
      transportCtx,
      preparedRequest,
    )
  ).result;
}

export interface ComputeRouteExecution {
  result: ActionResult<unknown>;
  route?: ComputeRouteSelection;
  /**
   * Authoritative metadata for the visual frame consumed by a coordinate
   * action. The opaque ref itself has already been claimed and cannot be
   * replayed; callers use this only to compare the selected provider's fresh
   * post-action frame with the exact frame that grounded the action.
   */
  observation?: VisualObservationEvidence;
}

export async function dispatchComputeRouteDetailed(
  bus: TransportBus,
  req: ActionRequest,
  platform: NodeJS.Platform = process.platform,
  transportCtx: TransportContext = { vars: {}, bus, refs: bus.refs },
  preparedRequest?: PreparedComputeRequest,
): Promise<ComputeRouteExecution> {
  const signal = req.signal ?? transportCtx.signal;
  signal?.throwIfAborted();
  const preparation = preparedRequest
    ? { status: "ready" as const, prepared: preparedRequest }
    : prepareComputeRequest(bus, {
        ...req,
        ...(signal ? { signal } : {}),
      });
  if (preparation.status === "rejected") {
    return {
      result: settleComputeEffect(
        preparation.result,
        computeCommandCanMutate(req.kind, req.params) || req.canMutate === true,
        undefined,
        "pre_dispatch",
      ),
    };
  }
  const prepared =
    signal && preparation.prepared.request.signal !== signal
      ? {
          ...preparation.prepared,
          request: { ...preparation.prepared.request, signal },
        }
      : preparation.prepared;
  const normalizedReq = prepared.request;
  if (normalizedReq.kind === "compute_find") {
    const result = settleComputeEffect(
      findInRefStore(bus, normalizedReq.params),
      false,
    );
    signal?.throwIfAborted();
    return { result };
  }
  if (normalizedReq.kind === "compute_observe") {
    const result = settleComputeEffect(
      observeComputeRefs(bus.refs, normalizedReq.params),
      false,
    );
    signal?.throwIfAborted();
    return { result };
  }
  if (normalizedReq.kind === "compute_assert") {
    const result = settleComputeEffect(
      assertComputeRefs(bus.refs, normalizedReq.params, prepared.refMatch),
      false,
    );
    signal?.throwIfAborted();
    return { result };
  }
  const refError = validatePreparedRef(bus, prepared);
  if (refError) {
    return {
      result: settleComputeEffect(
        refError,
        normalizedReq.canMutate === true,
        undefined,
        "pre_dispatch",
      ),
    };
  }

  if (normalizedReq.kind === "compute_wait") {
    return {
      result: settleComputeEffect(
        withRemedy(
          await waitForComputeCondition({
            params: normalizedReq.params,
            ref: prepared.refMatch?.ref,
            refs: bus.refs,
            ...(signal ? { signal } : {}),
            observe: async (params, waitSignal) => {
              const observation = await dispatchPreparedRequest(
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
              );
              return {
                result: observation.result,
                ...(observation.route
                  ? { transport: observation.route.transport }
                  : {}),
              };
            },
          }),
        ),
        false,
      ),
    };
  }

  return dispatchPreparedRequest(bus, prepared, platform, transportCtx);
}

async function dispatchPreparedRequest(
  bus: TransportBus,
  prepared: PreparedComputeRequest,
  platform: NodeJS.Platform,
  transportCtx: TransportContext,
): Promise<ComputeRouteExecution> {
  const normalizedReq = prepared.request;
  const signal = normalizedReq.signal ?? transportCtx.signal;
  const canMutate = normalizedReq.canMutate === true;
  const refOwner = prepared.refMatch
    ? transportForComputeRef(prepared.refMatch.ref.stable)
    : undefined;
  const route = planComputeRoute(normalizedReq, platform, refOwner);
  if (route.status === "unavailable") {
    return {
      result: settleComputeEffect(
        routeUnavailableResult(route),
        canMutate,
        undefined,
        "pre_dispatch",
      ),
    };
  }

  const kind = route.selection.transport;
  signal?.throwIfAborted();
  const staleBeforeOpen = validatePreparedRef(bus, prepared);
  if (staleBeforeOpen) {
    return {
      result: settleComputeEffect(
        staleBeforeOpen,
        canMutate,
        route.selection,
        "pre_dispatch",
      ),
      route: route.selection,
    };
  }
  const observation = await prepareCoordinateObservation(
    normalizedReq,
    route.selection,
  );
  if (observation.result) {
    return {
      result: settleComputeEffect(
        observation.result,
        canMutate,
        route.selection,
        "pre_dispatch",
      ),
      route: route.selection,
    };
  }
  let actionDispatched = false;
  try {
    const adapter = bus.get(kind);
    const adapted = adaptComputeAction(
      applyCoordinateObservation(normalizedReq, observation.claim),
      route.selection,
    );
    const dispatchReq = normalizeFocusForTransport(
      adapted,
      kind,
      normalizedReq.kind,
    );
    await adapter.open(transportCtx);
    signal?.throwIfAborted();
    const staleAfterOpen = validatePreparedRef(bus, prepared);
    if (staleAfterOpen) {
      return {
        result: settleComputeEffect(
          staleAfterOpen,
          canMutate,
          route.selection,
          "pre_dispatch",
        ),
        route: route.selection,
      };
    }
    const dispatchState = { actionDispatched: false };
    actionDispatched = true;
    const dispatchedResult = await executeSelectedPrimitive({
      bus,
      adapter,
      dispatchReq,
      logicalAction: normalizedReq.kind,
      kind,
      route: route.selection,
      transportCtx,
      canMutate,
      signal,
      state: dispatchState,
    });
    actionDispatched = dispatchState.actionDispatched;
    const result = await attachIssuedVisualObservation(
      dispatchedResult,
      normalizedReq,
      route.selection,
    );
    return {
      result: settleComputeEffect(
        result.ok ? result : withRemedy(result),
        canMutate,
        route.selection,
      ),
      route: route.selection,
      ...(observation.claim ? { observation: observation.claim.evidence } : {}),
    };
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
      return {
        result: settleComputeEffect(
          withRemedy(
            err({
              transport: kind,
              step: 0,
              action: normalizedReq.kind,
              reason: error.reason,
              suggestion: error.suggestion,
              minimum_capability: error.minimum_capability,
              exit_code: error.exit_code,
            }),
          ),
          canMutate,
          route.selection,
          actionDispatched ? "dispatched_failure" : "pre_dispatch",
        ),
        route: route.selection,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      result: settleComputeEffect(
        withRemedy(
          err({
            transport: kind,
            step: 0,
            action: normalizedReq.kind,
            reason: `${kind} failed on the selected route: ${message}`,
            suggestion:
              "repair the selected provider or explicitly replan; Uni-CLI did not change providers",
            minimum_capability: `compute.${normalizedReq.kind}.provider_unavailable`,
            exit_code: exitCodeFor("service_unavailable"),
          }),
        ),
        canMutate,
        route.selection,
        actionDispatched ? "dispatched_failure" : "pre_dispatch",
      ),
      route: route.selection,
    };
  } finally {
    await observation.claim?.release();
  }
}

async function prepareCoordinateObservation(
  req: ActionRequest,
  route: ComputeRouteSelection,
): Promise<{
  claim?: ClaimedVisualObservation;
  result?: ActionResult<unknown>;
}> {
  const points = coordinateObservationPoints(req.kind, req.params);
  if (points === undefined) return {};
  if (route.transport !== "visual" && route.transport !== "cua-driver") {
    return {
      result: visualObservationFailure(
        req.kind,
        new VisualObservationError(
          "provider_mismatch",
          `coordinate route ${route.transport} cannot own visual observations`,
        ),
      ),
    };
  }
  try {
    return {
      claim: await claimVisualObservation({
        ref: req.params.observation,
        provider: route.transport,
        targetScope: route.target_scope,
        points,
        session: req.params.session,
      }),
    };
  } catch (error) {
    return {
      result: visualObservationFailure(req.kind, error),
    };
  }
}

function applyCoordinateObservation(
  req: ActionRequest,
  claim: ClaimedVisualObservation | undefined,
): ActionRequest {
  if (!claim) return req;
  const points = coordinateObservationPoints(req.kind, req.params) ?? [];
  const transformed = points.map((point) => claim.transform(point));
  const { observation: _observation, ...params } = req.params;
  if (req.kind === "compute_drag") {
    const [from, to] = transformed;
    return {
      ...req,
      params: {
        ...params,
        fromX: from?.x,
        fromY: from?.y,
        toX: to?.x,
        toY: to?.y,
      },
    };
  }
  const [point] = transformed;
  return {
    ...req,
    params: { ...params, x: point?.x, y: point?.y },
  };
}

function coordinateObservationPoints(
  action: string,
  params: Readonly<Record<string, unknown>>,
): VisualObservationPoint[] | undefined {
  if (
    action === "compute_point_click" ||
    action === "compute_point_scroll" ||
    action === "compute_move_cursor"
  ) {
    return [
      {
        x: numberOrNaN(params.x),
        y: numberOrNaN(params.y),
        label: "point",
      },
    ];
  }
  if (action === "compute_drag") {
    return [
      {
        x: numberOrNaN(params.fromX),
        y: numberOrNaN(params.fromY),
        label: "drag start",
      },
      {
        x: numberOrNaN(params.toX),
        y: numberOrNaN(params.toY),
        label: "drag end",
      },
    ];
  }
  return undefined;
}

async function attachIssuedVisualObservation(
  result: ActionResult<unknown>,
  req: ActionRequest,
  route: ComputeRouteSelection,
): Promise<ActionResult<unknown>> {
  if (
    !result.ok ||
    req.kind !== "compute_screenshot" ||
    (route.transport !== "visual" && route.transport !== "cua-driver") ||
    (typeof req.params.path === "string" && req.params.path.trim().length > 0)
  ) {
    return result;
  }
  try {
    const observation = await issueVisualObservation({
      provider: route.transport,
      targetScope: route.target_scope,
      data: result.data,
      session: req.params.session,
    });
    return {
      ...result,
      data: {
        ...(isRecord(result.data) ? result.data : { value: result.data }),
        observation,
      },
    };
  } catch (error) {
    return visualObservationFailure(req.kind, error, route.transport);
  }
}

function visualObservationFailure(
  action: string,
  error: unknown,
  transport: VisualObservationProvider | "local-runtime" = "local-runtime",
): ActionResult<unknown> {
  const observationError =
    error instanceof VisualObservationError
      ? error
      : new VisualObservationError("store_unavailable", errorMessage(error));
  const inputFailure = new Set([
    "invalid_ref",
    "provider_mismatch",
    "scope_mismatch",
    "session_mismatch",
    "out_of_bounds",
  ]).has(observationError.code);
  const missingFailure =
    observationError.code === "not_found" ||
    observationError.code === "expired";
  return withRemedy(
    err({
      transport,
      adapter_path: "src/compute/visual-observation.ts",
      step: 0,
      action,
      reason: `visual observation ${observationError.code}: ${observationError.message}`,
      suggestion:
        "take a fresh inline compute screenshot through the same --via provider and session, then pass its opaque observation ref exactly once",
      minimum_capability: `compute.${action}.visual_observation`,
      retryable: false,
      exit_code: inputFailure
        ? exitCodeFor("usage_error")
        : missingFailure
          ? exitCodeFor("empty_result")
          : exitCodeFor("service_unavailable"),
    }),
  );
}

function numberOrNaN(value: unknown): number {
  return typeof value === "number" ? value : Number.NaN;
}

async function executeSelectedPrimitive(input: {
  bus: TransportBus;
  adapter: ReturnType<TransportBus["get"]>;
  dispatchReq: ActionRequest;
  logicalAction: string;
  kind: TransportKind;
  route: ComputeRouteSelection;
  transportCtx: TransportContext;
  canMutate: boolean;
  signal?: AbortSignal;
  state: { actionDispatched: boolean };
}): Promise<ActionResult<unknown>> {
  const failures: RecoveryAttempt[] = [];
  const policy = input.route.recovery;
  for (let attempt = 1; attempt <= policy.max_attempts; attempt += 1) {
    try {
      input.state.actionDispatched = true;
      const result = await dispatchSelectedPrimitiveOnce(input);
      if (
        shouldRetrySelectedPrimitive(
          result,
          undefined,
          input.canMutate,
          attempt,
          policy.max_attempts,
        )
      ) {
        failures.push({
          attempt,
          trigger: "retryable-read-failure",
          reason: result.ok
            ? "selected provider requested a read retry"
            : result.error.reason,
        });
        await input.adapter.recover?.(
          input.dispatchReq,
          result,
          input.transportCtx,
        );
        continue;
      }
      return attachRecoveryTrace(result, input, attempt, failures);
    } catch (error) {
      if (
        shouldRetrySelectedPrimitive(
          undefined,
          error,
          input.canMutate,
          attempt,
          policy.max_attempts,
        )
      ) {
        failures.push({
          attempt,
          trigger: "retryable-read-failure",
          reason: error instanceof Error ? error.message : String(error),
        });
        await input.adapter.recover?.(
          input.dispatchReq,
          error,
          input.transportCtx,
        );
        continue;
      }
      throw error;
    }
  }
  throw new Error("selected provider recovery exhausted without a result");
}

async function dispatchSelectedPrimitiveOnce(input: {
  bus: TransportBus;
  adapter: ReturnType<TransportBus["get"]>;
  dispatchReq: ActionRequest;
  logicalAction: string;
  kind: TransportKind;
  signal?: AbortSignal;
}): Promise<ActionResult<unknown>> {
  if (
    input.logicalAction === "compute_snapshot" &&
    (input.kind === "desktop-uia" ||
      input.kind === "desktop-atspi" ||
      input.kind === "cdp-browser")
  ) {
    const snapshot = await input.adapter.snapshot({
      format: readSnapshotFormat(input.dispatchReq.params),
      ...(input.dispatchReq.params.fresh === true ? { fresh: true } : {}),
      params: input.dispatchReq.params,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    input.signal?.throwIfAborted();
    return ok(enrichSnapshotWithRefProvenance(input.bus, snapshot, input.kind));
  }

  const result = await input.adapter.action<unknown>(input.dispatchReq);
  if (
    result.ok &&
    input.logicalAction === "compute_snapshot" &&
    input.kind === "desktop-ax"
  ) {
    const snapshot = await input.adapter.snapshot({
      format: readSnapshotFormat(input.dispatchReq.params),
      ...(input.dispatchReq.params.fresh === true ? { fresh: true } : {}),
      params: input.dispatchReq.params,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    input.signal?.throwIfAborted();
    return ok(enrichSnapshotWithRefProvenance(input.bus, snapshot, input.kind));
  }
  return result;
}

function shouldRetrySelectedPrimitive(
  result: ActionResult<unknown> | undefined,
  error: unknown,
  canMutate: boolean,
  attempt: number,
  maxAttempts: number,
): boolean {
  if (canMutate || attempt >= maxAttempts) return false;
  if (result && !result.ok) return result.error.retryable === true;
  if (isSidecarError(error)) {
    return error.exit_code === exitCodeFor("temp_failure");
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /timeout|timed out|disconnected|connection closed|EPIPE|ECONNRESET|sidecar (?:exited|closed)/i.test(
    message,
  );
}

function attachRecoveryTrace<T>(
  result: ActionResult<T>,
  input: {
    route: ComputeRouteSelection;
    kind: TransportKind;
  },
  attempts: number,
  failures: RecoveryAttempt[],
): ActionResult<T> {
  const trace: RecoveryTrace = {
    strategy: input.route.recovery.strategy,
    attempts,
    recovered: attempts > 1 && result.ok,
    provider: input.kind,
    physical_action: input.route.physical_action,
    failures,
  };
  return { ...result, recovery_trace: trace };
}

function settleComputeEffect<T>(
  result: ActionResult<T>,
  canMutate: boolean,
  route?: ComputeRouteSelection,
  phase?: "pre_dispatch" | "dispatched_failure" | "success",
): ActionResult<T> {
  return attachDefaultEffectVerdict(result, {
    canMutate,
    ...(phase ? { phase } : {}),
    ...(route ? { verification: route.verification } : {}),
  });
}

export function prepareComputeRequest(
  bus: TransportBus,
  req: ActionRequest,
): ComputeRequestPreparation {
  if (
    coordinateObservationPoints(req.kind, req.params) !== undefined &&
    req.params.observation === undefined
  ) {
    return {
      status: "rejected",
      result: visualObservationFailure(
        req.kind,
        new VisualObservationError(
          "invalid_ref",
          "coordinate action requires an opaque visual-observation ref",
        ),
      ),
    };
  }
  const argumentResolution = resolveComputeArguments(req.kind, req.params);
  if (!argumentResolution.ok) {
    return {
      status: "rejected",
      result: invalidComputeTarget(
        req.kind,
        argumentResolution.error,
        "pass only values accepted by `unicli describe compute <command>`",
      ),
    };
  }
  const targetError = validateComputeTargetParams(
    req.kind,
    argumentResolution.params,
  );
  if (targetError) return { status: "rejected", result: targetError };
  const normalizedReq = normalizeComputeRequest({
    ...req,
    params: argumentResolution.params,
    canMutate:
      computeCommandCanMutate(req.kind, argumentResolution.params) ||
      req.canMutate === true,
  });
  if (
    normalizedReq.kind === "compute_find" ||
    normalizedReq.kind === "compute_observe"
  ) {
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
  if (
    params.via !== undefined &&
    (typeof params.via !== "string" || !COMPUTE_ROUTE_NAMES.has(params.via))
  ) {
    return invalidComputeTarget(
      action,
      "via must be one of native, browser, process, driver, or visual",
      "select one declared compute route",
    );
  }
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
      transport: "local-runtime",
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
      transport: "local-runtime",
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
      transport: "local-runtime",
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
      transport: "local-runtime",
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

export function routeUnavailableResult(
  decision: Extract<ComputeRouteDecision, { status: "unavailable" }>,
): ActionResult<unknown> {
  return withRemedy(
    err({
      transport: decision.candidates[0]?.transport ?? "visual",
      adapter_path: "src/transport/compute-dispatch.ts",
      step: 0,
      action: decision.action,
      reason: `compute route unavailable: ${decision.reason}`,
      suggestion: decision.suggestion,
      minimum_capability: `compute.${decision.action}.route_unavailable`,
      exit_code: exitCodeFor("service_unavailable"),
    }),
  );
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
