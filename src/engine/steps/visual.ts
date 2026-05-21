/**
 * @owner   src/engine/steps/visual.ts
 * @does    Dispatch visual_* pipeline steps through the transport bus.
 * @needs   core/envelope, transport/types
 * @feeds   src/engine/executor.ts, src/engine/steps/index.ts
 * @breaks  Missing visual transport propagates as a bus lookup error.
 * @invariants Handlers are thin dispatch wrappers; action envelopes come from the transport.
 * @side-effects Depends on the selected visual transport action.
 * @perf    O(1) wrapper overhead.
 * @concurrency Safe when the underlying transport is safe.
 * @test    tests/unit/engine/steps/visual.test.ts
 * @stability beta
 * @since   0.222.0
 */

import type { Envelope } from "../../core/envelope.js";
import type {
  ActionResult,
  TransportAdapter,
  TransportBus,
  TransportContext,
} from "../../transport/types.js";

export interface VisualStepContext {
  bus: TransportBus;
  transportCtx: TransportContext;
  platform?: NodeJS.Platform;
}

async function dispatch<T>(
  ctx: VisualStepContext,
  kind: string,
  params: Record<string, unknown>,
): Promise<Envelope<T>> {
  const adapter: TransportAdapter = ctx.bus.require(kind, ctx.platform);
  await adapter.open(ctx.transportCtx);
  return (await adapter.action<T>({ kind, params })) as ActionResult<T>;
}

export async function handleVisualSnapshot(
  ctx: VisualStepContext,
  params: Record<string, unknown> = {},
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "visual_snapshot", params);
}

export async function handleVisualClick(
  ctx: VisualStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "visual_click", params);
}

export async function handleVisualType(
  ctx: VisualStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "visual_type", params);
}

export async function handleVisualKey(
  ctx: VisualStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "visual_key", params);
}

export async function handleVisualScroll(
  ctx: VisualStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "visual_scroll", params);
}

export async function handleVisualDrag(
  ctx: VisualStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "visual_drag", params);
}

export async function handleVisualWait(
  ctx: VisualStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "visual_wait", params);
}

export async function handleVisualAssert(
  ctx: VisualStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "visual_assert", params);
}

export async function handleVisualAsk(
  ctx: VisualStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "visual_ask", params);
}

export async function handleVisualBackend(
  ctx: VisualStepContext,
  params: Record<string, unknown> = {},
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "visual_backend", params);
}

export async function handleVisualLaunch(
  ctx: VisualStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "visual_launch", params);
}

export const VISUAL_STEP_HANDLERS = {
  visual_snapshot: handleVisualSnapshot,
  visual_click: handleVisualClick,
  visual_type: handleVisualType,
  visual_key: handleVisualKey,
  visual_scroll: handleVisualScroll,
  visual_drag: handleVisualDrag,
  visual_wait: handleVisualWait,
  visual_assert: handleVisualAssert,
  visual_ask: handleVisualAsk,
  visual_backend: handleVisualBackend,
  visual_launch: handleVisualLaunch,
} as const;

export type VisualStepKind = keyof typeof VISUAL_STEP_HANDLERS;
