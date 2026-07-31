import type { Envelope } from "../../core/envelope.js";
import { buildTransportCtx, getBus } from "../../transport/bus.js";
import { dispatchComputeRoute } from "../../transport/compute-dispatch.js";
import type { TransportBus, TransportContext } from "../../transport/types.js";
import type { PipelineContext } from "../executor.js";
import { registerStep, type StepHandler } from "../step-registry.js";

export interface ComputeStepContext {
  bus: TransportBus;
  transportCtx: TransportContext;
  platform?: NodeJS.Platform;
}

async function dispatch<T>(
  ctx: ComputeStepContext,
  kind: ComputeStepKind,
  params: Record<string, unknown>,
): Promise<Envelope<T>> {
  return dispatchComputeRoute(
    ctx.bus,
    {
      kind,
      params,
      ...(ctx.transportCtx.signal ? { signal: ctx.transportCtx.signal } : {}),
    },
    ctx.platform,
    ctx.transportCtx,
  ) as Promise<Envelope<T>>;
}

export const handleComputeApps = (
  ctx: ComputeStepContext,
  params: Record<string, unknown> = {},
) => dispatch(ctx, "compute_apps", params);
export const handleComputeWindows = (
  ctx: ComputeStepContext,
  params: Record<string, unknown> = {},
) => dispatch(ctx, "compute_windows", params);
export const handleComputeSnapshot = (
  ctx: ComputeStepContext,
  params: Record<string, unknown> = {},
) => dispatch(ctx, "compute_snapshot", params);
export const handleComputeFind = (
  ctx: ComputeStepContext,
  params: Record<string, unknown>,
) => dispatch(ctx, "compute_find", params);
export const handleComputeClick = (
  ctx: ComputeStepContext,
  params: Record<string, unknown>,
) => dispatch(ctx, "compute_click", params);
export const handleComputePointClick = (
  ctx: ComputeStepContext,
  params: Record<string, unknown>,
) => dispatch(ctx, "compute_point_click", params);
export const handleComputeDrag = (
  ctx: ComputeStepContext,
  params: Record<string, unknown>,
) => dispatch(ctx, "compute_drag", params);
export const handleComputeType = (
  ctx: ComputeStepContext,
  params: Record<string, unknown>,
) => dispatch(ctx, "compute_type", params);
export const handleComputeText = (
  ctx: ComputeStepContext,
  params: Record<string, unknown>,
) => dispatch(ctx, "compute_text", params);
export const handleComputePress = (
  ctx: ComputeStepContext,
  params: Record<string, unknown>,
) => dispatch(ctx, "compute_press", params);
export const handleComputeScroll = (
  ctx: ComputeStepContext,
  params: Record<string, unknown>,
) => dispatch(ctx, "compute_scroll", params);
export const handleComputePointScroll = (
  ctx: ComputeStepContext,
  params: Record<string, unknown>,
) => dispatch(ctx, "compute_point_scroll", params);
export const handleComputeLaunch = (
  ctx: ComputeStepContext,
  params: Record<string, unknown>,
) => dispatch(ctx, "compute_launch", params);
export const handleComputeScreenshot = (
  ctx: ComputeStepContext,
  params: Record<string, unknown> = {},
) => dispatch(ctx, "compute_screenshot", params);
export const handleComputeSessionStart = (
  ctx: ComputeStepContext,
  params: Record<string, unknown>,
) => dispatch(ctx, "compute_session_start", params);
export const handleComputeSessionState = (
  ctx: ComputeStepContext,
  params: Record<string, unknown>,
) => dispatch(ctx, "compute_session_state", params);
export const handleComputeSessionEscalate = (
  ctx: ComputeStepContext,
  params: Record<string, unknown>,
) => dispatch(ctx, "compute_session_escalate", params);
export const handleComputeSessionEnd = (
  ctx: ComputeStepContext,
  params: Record<string, unknown>,
) => dispatch(ctx, "compute_session_end", params);
export const handleComputeCdpAttach = (
  ctx: ComputeStepContext,
  params: Record<string, unknown>,
) => dispatch(ctx, "compute_cdp_attach", params);
export const handleComputeEvaluate = (
  ctx: ComputeStepContext,
  params: Record<string, unknown>,
) => dispatch(ctx, "compute_evaluate", params);
export const handleComputeWait = (
  ctx: ComputeStepContext,
  params: Record<string, unknown>,
) => dispatch(ctx, "compute_wait", params);
export const handleComputeObserve = (
  ctx: ComputeStepContext,
  params: Record<string, unknown>,
) => dispatch(ctx, "compute_observe", params);
export const handleComputeAssert = (
  ctx: ComputeStepContext,
  params: Record<string, unknown>,
) => dispatch(ctx, "compute_assert", params);

export const COMPUTE_STEP_HANDLERS = {
  compute_apps: handleComputeApps,
  compute_windows: handleComputeWindows,
  compute_snapshot: handleComputeSnapshot,
  compute_find: handleComputeFind,
  compute_click: handleComputeClick,
  compute_point_click: handleComputePointClick,
  compute_drag: handleComputeDrag,
  compute_type: handleComputeType,
  compute_text: handleComputeText,
  compute_press: handleComputePress,
  compute_scroll: handleComputeScroll,
  compute_point_scroll: handleComputePointScroll,
  compute_launch: handleComputeLaunch,
  compute_screenshot: handleComputeScreenshot,
  compute_session_start: handleComputeSessionStart,
  compute_session_state: handleComputeSessionState,
  compute_session_escalate: handleComputeSessionEscalate,
  compute_session_end: handleComputeSessionEnd,
  compute_cdp_attach: handleComputeCdpAttach,
  compute_evaluate: handleComputeEvaluate,
  compute_wait: handleComputeWait,
  compute_observe: handleComputeObserve,
  compute_assert: handleComputeAssert,
} as const;

export type ComputeStepKind = keyof typeof COMPUTE_STEP_HANDLERS;

function readParams(config: unknown): Record<string, unknown> {
  return config && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};
}

function makeRegisteredStep(kind: ComputeStepKind): StepHandler {
  return (async (
    ctx: PipelineContext,
    config: unknown,
  ): Promise<PipelineContext> => {
    const bus = getBus();
    const envelope = await COMPUTE_STEP_HANDLERS[kind](
      { bus, transportCtx: buildTransportCtx(ctx) },
      readParams(config),
    );
    ctx.vars["lastEnvelope"] = envelope;
    return { ...ctx, data: envelope.ok ? envelope.data : envelope };
  }) as StepHandler;
}

for (const kind of Object.keys(COMPUTE_STEP_HANDLERS) as ComputeStepKind[]) {
  registerStep(kind, makeRegisteredStep(kind));
}
/**
 * @owner       src::engine::steps::compute
 * @does        Register compute pipeline steps and dispatch each through one planned provider with request identity and cancellation intact.
 * @needs       transport bus/context/route planner, pipeline context, step registry.
 * @feeds       YAML pipeline compute actions.
 * @breaks      Returns transport envelopes; cancellation escapes immediately rather than falling through to another physical transport.
 * @invariants  The PipelineContext AbortSignal is present on both TransportContext and ActionRequest.
 * @side-effects Dispatches one selected desktop, browser, visual, or subprocess operation.
 * @perf        Constant wrapper overhead around transport work.
 * @concurrency Request state is structural and never stored at module scope.
 * @test        tests/unit/engine/compute-steps.test.ts, tests/unit/engine/executor.test.ts
 * @stability   stable
 * @since       2026-06-29
 */
