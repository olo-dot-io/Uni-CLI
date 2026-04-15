/**
 * CUA pipeline step handlers — every cua_* action delegates to the
 * transport bus (`bus.require`/`adapter.open`/`adapter.action`). The bus
 * routes to whichever transport declares the step; `action()` never
 * throws — callers always receive an envelope.
 */

import type { Envelope } from "../../core/envelope.js";
import type {
  ActionResult,
  TransportAdapter,
  TransportBus,
  TransportContext,
} from "../../transport/types.js";

/** Shared shape used by every cua_* handler. */
export interface CuaStepContext {
  bus: TransportBus;
  transportCtx: TransportContext;
  platform?: NodeJS.Platform;
}

async function dispatch<T>(
  ctx: CuaStepContext,
  kind: string,
  params: Record<string, unknown>,
): Promise<Envelope<T>> {
  const adapter: TransportAdapter = ctx.bus.require(kind, ctx.platform);
  await adapter.open(ctx.transportCtx);
  return (await adapter.action<T>({ kind, params })) as ActionResult<T>;
}

export async function handleCuaSnapshot(
  ctx: CuaStepContext,
  params: Record<string, unknown> = {},
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "cua_snapshot", params);
}

export async function handleCuaClick(
  ctx: CuaStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "cua_click", params);
}

export async function handleCuaType(
  ctx: CuaStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "cua_type", params);
}

export async function handleCuaKey(
  ctx: CuaStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "cua_key", params);
}

export async function handleCuaScroll(
  ctx: CuaStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "cua_scroll", params);
}

export async function handleCuaDrag(
  ctx: CuaStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "cua_drag", params);
}

export async function handleCuaWait(
  ctx: CuaStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "cua_wait", params);
}

export async function handleCuaAssert(
  ctx: CuaStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "cua_assert", params);
}

export async function handleCuaAsk(
  ctx: CuaStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "cua_ask", params);
}

export async function handleCuaBackend(
  ctx: CuaStepContext,
  params: Record<string, unknown> = {},
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "cua_backend", params);
}

export async function handleCuaLaunch(
  ctx: CuaStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "cua_launch", params);
}

/** Kind → handler dispatch table (consumed by the yaml-runner switch). */
export const CUA_STEP_HANDLERS = {
  cua_snapshot: handleCuaSnapshot,
  cua_click: handleCuaClick,
  cua_type: handleCuaType,
  cua_key: handleCuaKey,
  cua_scroll: handleCuaScroll,
  cua_drag: handleCuaDrag,
  cua_wait: handleCuaWait,
  cua_assert: handleCuaAssert,
  cua_ask: handleCuaAsk,
  cua_backend: handleCuaBackend,
  cua_launch: handleCuaLaunch,
} as const;

export type CuaStepKind = keyof typeof CUA_STEP_HANDLERS;
