/**
 * @owner       src::compute::wait
 * @does        Bind and evaluate ref/text/state waits against fresh snapshots of one immutable compute target.
 * @needs       Node cancellable timers, core envelopes, transport refs/types
 * @feeds       transport cascade compute_wait execution
 * @breaks      Treating elapsed time or an unrelated snapshot as condition evidence creates false success.
 * @invariants  A wait has one target, one deadline, and at least one predicate; success requires a fresh target observation; caller cancellation remains exact.
 * @side-effects Repeatedly invokes the caller-supplied read-only snapshot observer until match or deadline.
 * @perf        One target snapshot every 50ms, bounded to 300s.
 * @concurrency The caller signal and private deadline signal are combined without process-global state.
 * @test        tests/unit/compute-cascade.test.ts
 * @stability   experimental
 * @since       0.400.2
 */

import { setTimeout as delay } from "node:timers/promises";

import { err, exitCodeFor, ok } from "../core/envelope.js";
import { readCdpEndpoint } from "../transport/cdp-endpoint.js";
import type { ElementRef, RefStore } from "../transport/refs.js";
import type {
  ActionResult,
  Snapshot,
  TransportKind,
} from "../transport/types.js";

export const MAX_COMPUTE_WAIT_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 50;

type ComputeWaitState =
  | "appear"
  | "disappear"
  | "focused"
  | "enabled"
  | "checked";

interface BoundComputeWait {
  state: ComputeWaitState;
  timeoutMs: number;
  text?: string;
  stableRef?: string;
  app?: string;
  target: Record<string, unknown>;
  snapshotParams: Record<string, unknown>;
}

export interface ComputeWaitObservation {
  result: ActionResult<unknown>;
  transport?: TransportKind;
}

export interface ComputeWaitOptions {
  params: Record<string, unknown>;
  ref?: ElementRef;
  refs: RefStore;
  signal?: AbortSignal;
  observe: (
    params: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<ComputeWaitObservation>;
}

export async function waitForComputeCondition(
  options: ComputeWaitOptions,
): Promise<ActionResult<unknown>> {
  const binding = bindComputeWait(options.params, options.ref);
  if (!binding.ok) return binding.result;

  const startedAt = Date.now();
  const deadline = startedAt + binding.value.timeoutMs;
  const timeoutSignal = AbortSignal.timeout(binding.value.timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  let attempts = 0;
  let successfulObservations = 0;
  let lastFailure: ActionResult<unknown> | undefined;
  let lastTransport: TransportKind | undefined;

  try {
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const observation = await options.observe(
        binding.value.snapshotParams,
        signal,
      );
      attempts++;
      signal.throwIfAborted();
      if (observation.result.ok && observation.transport) {
        successfulObservations++;
        lastTransport = observation.transport;
        if (
          conditionMatches(
            options.refs,
            observation.result.data as Snapshot,
            observation.transport,
            binding.value,
          )
        ) {
          return ok({
            matched: true,
            state: binding.value.state,
            attempts,
            elapsedMs: Date.now() - startedAt,
            target: targetSummary(binding.value, observation.transport),
          });
        }
      } else {
        lastFailure = observation.result;
        if (!observation.result.ok && isTargetAbsent(observation.result)) {
          if (binding.value.state === "disappear") {
            return ok({
              matched: true,
              state: binding.value.state,
              attempts,
              elapsedMs: Date.now() - startedAt,
              target: targetSummary(
                binding.value,
                observation.result.error.transport,
              ),
              observed: "target_absent",
            });
          }
        } else if (
          !observation.result.ok &&
          observation.result.error.retryable !== true
        ) {
          return observation.result;
        }
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await delay(Math.min(POLL_INTERVAL_MS, remainingMs), undefined, {
        signal,
      });
    }
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (!timeoutSignal.aborted) throw error;
  }

  return timeoutResult(
    binding.value,
    attempts,
    successfulObservations,
    lastTransport,
    lastFailure,
  );
}

export function readComputeTargetApp(
  params: Record<string, unknown>,
): string | undefined {
  for (const key of ["app", "bundleId", "processName"] as const) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function hasCdpTarget(params: Record<string, unknown>): boolean {
  return readCdpEndpoint(params) !== undefined;
}

export function transportForComputeRef(
  stable: string,
): TransportKind | undefined {
  if (stable.startsWith("cdp-browser:") || stable.startsWith("cdp:")) {
    return "cdp-browser";
  }
  if (stable.startsWith("desktop-uia:")) return "desktop-uia";
  if (stable.startsWith("desktop-atspi:")) return "desktop-atspi";
  if (stable.startsWith("desktop-ax:")) return "desktop-ax";
  return undefined;
}

function bindComputeWait(
  params: Record<string, unknown>,
  ref: ElementRef | undefined,
):
  | { ok: true; value: BoundComputeWait }
  | { ok: false; result: ActionResult<unknown> } {
  const refValue = readNonEmptyString(params.ref);
  const stableRef =
    ref?.stable ??
    (refValue && transportForComputeRef(refValue) ? refValue : undefined);
  const text =
    typeof params.text === "string" && params.text.length > 0
      ? params.text
      : undefined;
  if (!stableRef && !text) {
    return invalid(
      "compute_wait requires a non-empty ref or text condition",
      "pass --ref <unicli-ref> or --text <text>",
    );
  }

  const state = params.state === undefined ? "appear" : params.state;
  if (
    state !== "appear" &&
    state !== "disappear" &&
    state !== "focused" &&
    state !== "enabled" &&
    state !== "checked"
  ) {
    return invalid(
      `unsupported compute wait state: ${String(state)}`,
      "use --state appear, disappear, focused, enabled, or checked",
    );
  }
  if (state !== "appear" && state !== "disappear" && !stableRef) {
    return invalid(
      `the ${state} state requires a bound element ref`,
      `pass --ref <unicli-ref> with --state ${state}`,
    );
  }

  const timeoutMs = params.timeoutMs;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_COMPUTE_WAIT_TIMEOUT_MS
  ) {
    return invalid(
      `timeoutMs must be an integer from 1 to ${String(MAX_COMPUTE_WAIT_TIMEOUT_MS)}`,
      `pass --timeout <ms> between 1 and ${String(MAX_COMPUTE_WAIT_TIMEOUT_MS)}`,
    );
  }

  const explicitTarget = readComputeTargetApp(params);
  const app = readNonEmptyString(params.app) ?? ref?.app;
  if (!explicitTarget && !hasCdpTarget(params) && !ref) {
    return invalid(
      "compute_wait cannot identify an immutable observation target",
      "pass --app, use a live Uni-CLI ref, or attach an explicit CDP session",
    );
  }

  const snapshotParams = snapshotTarget(params);
  if (
    ref?.app &&
    explicitTarget === undefined &&
    snapshotParams.windowId === undefined
  ) {
    snapshotParams.app = ref.app;
  }
  if (stableRef) snapshotParams.stable = stableRef;
  const target = targetSummaryParams(snapshotParams);
  snapshotParams.format = "json";
  snapshotParams.fresh = true;
  snapshotParams.maxDepth = 64;
  return {
    ok: true,
    value: {
      state,
      timeoutMs,
      ...(text ? { text } : {}),
      ...(stableRef ? { stableRef } : {}),
      ...(app ? { app } : {}),
      target,
      snapshotParams,
    },
  };
}

function snapshotTarget(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  for (const key of [
    "app",
    "bundleId",
    "processName",
    "pid",
    "windowId",
    "port",
    "webSocketDebuggerUrl",
    "targetId",
    "debugPort",
  ] as const) {
    if (params[key] !== undefined) target[key] = params[key];
  }
  return target;
}

function conditionMatches(
  refs: RefStore,
  snapshot: Snapshot,
  transport: TransportKind,
  condition: BoundComputeWait,
): boolean {
  const observedRef = condition.stableRef
    ? snapshotRef(refs, snapshot, transport, condition.stableRef)
    : undefined;
  const refPresent = condition.stableRef ? observedRef !== undefined : true;
  const textPresent = condition.text
    ? snapshotText(snapshot).includes(condition.text)
    : true;
  if (condition.state === "disappear") {
    return (
      (!condition.stableRef || !refPresent) && (!condition.text || !textPresent)
    );
  }
  if (
    condition.state === "focused" ||
    condition.state === "enabled" ||
    condition.state === "checked"
  ) {
    return (
      (observedRef?.states ?? []).some(
        (value) => value.toLowerCase() === condition.state,
      ) && textPresent
    );
  }
  return refPresent && textPresent;
}

function snapshotRef(
  refs: RefStore,
  snapshot: Snapshot,
  transport: TransportKind,
  stable: string,
): ElementRef | undefined {
  const scope = snapshotScope(snapshot);
  const matches = refs
    .matches(canonicalComputeRef(stable))
    .filter(
      (match) =>
        match.bucket.transport === transport &&
        (scope === undefined || match.bucket.scope === scope),
    );
  return matches.length === 1 ? matches[0]?.ref : undefined;
}

function canonicalComputeRef(stable: string): string {
  return stable.startsWith("cdp:")
    ? `cdp-browser:${stable.slice("cdp:".length)}`
    : stable;
}

function snapshotScope(snapshot: Snapshot): string | undefined {
  return isRecord(snapshot.refs) && typeof snapshot.refs.scope === "string"
    ? snapshot.refs.scope
    : undefined;
}

function snapshotText(snapshot: Snapshot): string {
  const text = Buffer.isBuffer(snapshot.data)
    ? snapshot.data.toString("utf8")
    : snapshot.data;
  if (snapshot.encoding !== "json" && snapshot.format !== "json") return text;
  try {
    return visibleSnapshotText(JSON.parse(text) as unknown).join("\n");
  } catch {
    return "";
  }
}

function visibleSnapshotText(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(visibleSnapshotText);
  if (!isRecord(value)) return [];
  const text: string[] = [];
  for (const key of ["name", "value"] as const) {
    if (typeof value[key] === "string") text.push(value[key]);
  }
  if (Array.isArray(value.children)) {
    text.push(...value.children.flatMap(visibleSnapshotText));
  }
  return text;
}

function targetSummary(
  condition: BoundComputeWait,
  transport: TransportKind,
): Record<string, unknown> {
  return {
    ...condition.target,
    ...(condition.stableRef ? { ref: condition.stableRef } : {}),
    transport,
  };
}

function targetSummaryParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const key of [
    "app",
    "bundleId",
    "processName",
    "pid",
    "windowId",
    "port",
  ] as const) {
    if (params[key] !== undefined) summary[key] = params[key];
  }
  return summary;
}

function invalid(
  reason: string,
  suggestion: string,
): { ok: false; result: ActionResult<unknown> } {
  return {
    ok: false,
    result: err({
      transport: "visual",
      step: 0,
      action: "compute_wait",
      reason,
      suggestion,
      minimum_capability: "compute.compute_wait.invalid_input",
      exit_code: exitCodeFor("usage_error"),
    }),
  };
}

function timeoutResult(
  condition: BoundComputeWait,
  attempts: number,
  successfulObservations: number,
  transport: TransportKind | undefined,
  lastFailure: ActionResult<unknown> | undefined,
): ActionResult<unknown> {
  const failure =
    lastFailure && !lastFailure.ok ? lastFailure.error : undefined;
  return err({
    transport: transport ?? failure?.transport ?? "visual",
    step: 0,
    action: "compute_wait",
    reason:
      successfulObservations > 0
        ? `condition was not satisfied within ${String(condition.timeoutMs)}ms after ${String(attempts)} attempts (${String(successfulObservations)} target observations)`
        : `target could not be observed within ${String(condition.timeoutMs)}ms${failure?.minimum_capability ? ` (${failure.minimum_capability})` : ""}`,
    suggestion:
      "take a fresh target-scoped snapshot, verify the condition, and retry",
    minimum_capability: "compute.compute_wait.timeout",
    retryable: true,
    exit_code: exitCodeFor("empty_result"),
  });
}

function isTargetAbsent(result: ActionResult<unknown>): boolean {
  if (result.ok) return false;
  const capability = result.error.minimum_capability?.toLowerCase() ?? "";
  return (
    capability.includes("target_not_found") ||
    capability.endsWith(".no_element")
  );
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
