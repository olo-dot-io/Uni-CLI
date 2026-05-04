/**
 * Windows UIA and Linux AT-SPI direct pipeline step handlers.
 *
 * These handlers mirror the CUA/AX bus-dispatch shape: the YAML runner can use
 * low-level `uia_*` / `atspi_*` actions directly, while transport availability,
 * platform gates, and sidecar errors remain owned by the transport bus.
 */

import type { Envelope } from "../../core/envelope.js";
import type {
  ActionResult,
  TransportAdapter,
  TransportBus,
  TransportContext,
} from "../../transport/types.js";

export interface DesktopSidecarStepContext {
  bus: TransportBus;
  transportCtx: TransportContext;
  platform?: NodeJS.Platform;
}

type DesktopSidecarStepHandler = (
  ctx: DesktopSidecarStepContext,
  params: Record<string, unknown>,
) => Promise<Envelope<unknown>>;

async function dispatch<T>(
  ctx: DesktopSidecarStepContext,
  kind: string,
  params: Record<string, unknown>,
): Promise<Envelope<T>> {
  const adapter: TransportAdapter = ctx.bus.require(kind, ctx.platform);
  await adapter.open(ctx.transportCtx);
  return (await adapter.action<T>({ kind, params })) as ActionResult<T>;
}

function handler(kind: string): DesktopSidecarStepHandler {
  return (ctx, params) => dispatch(ctx, kind, params);
}

export const DESKTOP_SIDECAR_STEP_HANDLERS = {
  uia_apps: handler("uia_apps"),
  uia_windows: handler("uia_windows"),
  uia_snapshot: handler("uia_snapshot"),
  uia_find: handler("uia_find"),
  uia_invoke: handler("uia_invoke"),
  uia_set_value: handler("uia_set_value"),
  uia_focus: handler("uia_focus"),
  uia_press: handler("uia_press"),
  uia_scroll: handler("uia_scroll"),
  uia_screenshot: handler("uia_screenshot"),
  uia_wait: handler("uia_wait"),
  uia_observe: handler("uia_observe"),
  uia_assert: handler("uia_assert"),
  atspi_apps: handler("atspi_apps"),
  atspi_windows: handler("atspi_windows"),
  atspi_snapshot: handler("atspi_snapshot"),
  atspi_find: handler("atspi_find"),
  atspi_invoke: handler("atspi_invoke"),
  atspi_set_value: handler("atspi_set_value"),
  atspi_focus: handler("atspi_focus"),
  atspi_press: handler("atspi_press"),
  atspi_scroll: handler("atspi_scroll"),
  atspi_screenshot: handler("atspi_screenshot"),
  atspi_wait: handler("atspi_wait"),
  atspi_observe: handler("atspi_observe"),
  atspi_assert: handler("atspi_assert"),
} as const;

export type DesktopSidecarStepKind = keyof typeof DESKTOP_SIDECAR_STEP_HANDLERS;

export function isDesktopSidecarStep(
  action: string,
): action is DesktopSidecarStepKind {
  return action in DESKTOP_SIDECAR_STEP_HANDLERS;
}

export function getDesktopSidecarStepHandler(
  action: DesktopSidecarStepKind,
): DesktopSidecarStepHandler;
export function getDesktopSidecarStepHandler(
  action: string,
): DesktopSidecarStepHandler | undefined;
export function getDesktopSidecarStepHandler(
  action: string,
): DesktopSidecarStepHandler | undefined {
  return DESKTOP_SIDECAR_STEP_HANDLERS[action as DesktopSidecarStepKind];
}
