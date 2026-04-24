/**
 * macOS native (desktop-ax) pipeline step handlers — every ax_* action
 * delegates to the transport bus, honours the `platforms:["darwin"]`
 * gate, and surfaces `NoTransportForStepError` envelopes with a
 * `minimum_capability` hint for the self-repair loop.
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

export async function handleAxSnapshot(
  ctx: DesktopAxStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "ax_snapshot", params);
}

export async function handleAxFocusedRead(
  ctx: DesktopAxStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "ax_focused_read", params);
}

export async function handleAxSetValue(
  ctx: DesktopAxStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "ax_set_value", params);
}

export async function handleAxPress(
  ctx: DesktopAxStepContext,
  params: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  return dispatch(ctx, "ax_press", params);
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
  ax_snapshot: handleAxSnapshot,
  ax_focused_read: handleAxFocusedRead,
  ax_set_value: handleAxSetValue,
  ax_press: handleAxPress,
  clipboard_read: handleClipboardRead,
  clipboard_write: handleClipboardWrite,
  launch_app: handleLaunchApp,
  focus_window: handleFocusWindow,
} as const;

export type DesktopAxStepKind = keyof typeof DESKTOP_AX_STEP_HANDLERS;
