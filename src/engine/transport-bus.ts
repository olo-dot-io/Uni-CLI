/**
 * Lazily-created transport bus — the capability registry for the runner.
 *
 * All seven v0.212 transports are registered so `bus.require(step)` gives
 * an honest answer for every pipeline step name in the capability matrix.
 * Registering the HTTP, subprocess, and CDP transports here does NOT
 * eagerly open Chrome or spawn a process; `open()` is only called when a
 * handler dispatches through the bus.
 */

import { createTransportBus } from "../transport/bus.js";
import { CuaTransport } from "../transport/adapters/cua.js";
import { DesktopAxTransport } from "../transport/adapters/desktop-ax.js";
import { DesktopUiaTransport } from "../transport/adapters/desktop-uia.js";
import { DesktopAtspiTransport } from "../transport/adapters/desktop-atspi.js";
import { HttpTransport } from "../transport/adapters/http.js";
import { SubprocessTransport } from "../transport/adapters/subprocess.js";
import { CdpBrowserTransport } from "../transport/adapters/cdp-browser.js";
import type { TransportBus, TransportContext } from "../transport/types.js";
import type { PipelineContext } from "./executor.js";

let sharedBus: TransportBus | undefined;

export function getBus(): TransportBus {
  if (sharedBus) return sharedBus;
  const bus = createTransportBus();
  bus.register(new HttpTransport());
  bus.register(new CdpBrowserTransport());
  bus.register(new SubprocessTransport());
  bus.register(new DesktopAxTransport());
  bus.register(new DesktopUiaTransport());
  bus.register(new DesktopAtspiTransport());
  bus.register(new CuaTransport());
  sharedBus = bus;
  return bus;
}

/** Exposed for tests — reset the shared bus between runs. */
export function __resetTransportBusForTests(): void {
  sharedBus = undefined;
}

export function buildTransportCtx(ctx: PipelineContext): TransportContext {
  return {
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    cookieHeader: ctx.cookieHeader,
    vars: ctx.vars,
    bus: getBus(),
  };
}
