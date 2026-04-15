/**
 * macOS native (desktop-ax) pipeline step handlers.
 *
 * Every handler calls `ctx.bus.require(<step>)` — the bus walks the
 * capability matrix, honours the `platforms:["darwin"]` gate on these
 * steps, and returns either the desktop-ax adapter or throws a typed
 * `NoTransportForStepError` whose envelope already carries the
 * `minimum_capability` hint for the self-repair loop.
 *
 * The handlers themselves never throw — they let the bus error surface
 * naturally so the runner treats platform-gated + unregistered the same
 * way.
 */

import type { Envelope } from "../../core/envelope.js";
import type {
  ActionResult,
  TransportAdapter,
  TransportBus,
  TransportContext,
} from "../../transport/types.js";

export interface DesktopAxStepContext {
  bus: TransportBus;
  transportCtx: TransportContext;
  platform?: NodeJS.Platform;
}

async function dispatch<T>(
  ctx: DesktopAxStepContext,
  kind: string,
  params: Record<string, unknown>,
): Promise<Envelope<T>> {
  const adapter: TransportAdapter = ctx.bus.require(kind, ctx.platform);
  await adapter.open(ctx.transportCtx);
  return (await adapter.action<T>({ kind, params })) as ActionResult<T>;
}

export async function handleAxFocus(
  ctx: DesktopAxStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "ax_focus", params);
}

export async function handleAxMenuSelect(
  ctx: DesktopAxStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "ax_menu_select", params);
}

export async function handleApplescript(
  ctx: DesktopAxStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "applescript", params);
}

export async function handleClipboardRead(
  ctx: DesktopAxStepContext,
  params: Record<string, unknown> = {},
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "clipboard_read", params);
}

export async function handleClipboardWrite(
  ctx: DesktopAxStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "clipboard_write", params);
}

export async function handleLaunchApp(
  ctx: DesktopAxStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "launch_app", params);
}

export async function handleFocusWindow(
  ctx: DesktopAxStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "focus_window", params);
}

export const DESKTOP_AX_STEP_HANDLERS = {
  ax_focus: handleAxFocus,
  ax_menu_select: handleAxMenuSelect,
  applescript: handleApplescript,
  clipboard_read: handleClipboardRead,
  clipboard_write: handleClipboardWrite,
  launch_app: handleLaunchApp,
  focus_window: handleFocusWindow,
} as const;

export type DesktopAxStepKind = keyof typeof DESKTOP_AX_STEP_HANDLERS;
