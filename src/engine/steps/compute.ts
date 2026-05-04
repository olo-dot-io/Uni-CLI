import type { Envelope } from "../../core/envelope.js";
import { buildTransportCtx, getBus } from "../../transport/bus.js";
import { tryCascade } from "../../transport/cascade.js";
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
  return tryCascade(
    ctx.bus,
    { kind, params },
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
export const handleComputeType = (
  ctx: ComputeStepContext,
  params: Record<string, unknown>,
) => dispatch(ctx, "compute_type", params);
export const handleComputePress = (
  ctx: ComputeStepContext,
  params: Record<string, unknown>,
) => dispatch(ctx, "compute_press", params);
export const handleComputeScroll = (
  ctx: ComputeStepContext,
  params: Record<string, unknown>,
) => dispatch(ctx, "compute_scroll", params);
export const handleComputeLaunch = (
  ctx: ComputeStepContext,
  params: Record<string, unknown>,
) => dispatch(ctx, "compute_launch", params);
export const handleComputeScreenshot = (
  ctx: ComputeStepContext,
  params: Record<string, unknown> = {},
) => dispatch(ctx, "compute_screenshot", params);
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
  compute_type: handleComputeType,
  compute_press: handleComputePress,
  compute_scroll: handleComputeScroll,
  compute_launch: handleComputeLaunch,
  compute_screenshot: handleComputeScreenshot,
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
