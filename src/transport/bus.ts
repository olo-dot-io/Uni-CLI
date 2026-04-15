/**
 * TransportBus — composition layer that routes a pipeline step to the
 * transport that can execute it on the current host.
 *
 * The bus consults {@link CAPABILITY_MATRIX} at parse time so the YAML
 * runner can refuse a pipeline before any I/O happens. When no transport
 * satisfies the step (either unregistered or platform-gated), the bus
 * throws a {@link NoTransportForStepError} carrying an envelope with the
 * repair hint `minimum_capability: "<kind>.<step>"` so agents know which
 * transport to add or fix.
 *
 * This module also owns the process-wide shared bus lifecycle
 * ({@link getBus}) used by the YAML runner and the `buildTransportCtx`
 * helper that assembles a {@link TransportContext} from a minimal slice
 * of runner state. Plugins register their own transports against the
 * same shared bus:
 *
 * ```ts
 * import { getBus, type TransportAdapter } from "@zenalexa/unicli/transport";
 *
 * class MyTransport implements TransportAdapter { ... }
 * getBus().register(new MyTransport());
 * ```
 */

import { err, type EnvelopeErr } from "../core/envelope.js";
import {
  CAPABILITY_MATRIX,
  stepPlatform,
  stepSupportedBy,
} from "./capability.js";
import { CuaTransport } from "./adapters/cua.js";
import { DesktopAxTransport } from "./adapters/desktop-ax.js";
import { DesktopUiaTransport } from "./adapters/desktop-uia.js";
import { DesktopAtspiTransport } from "./adapters/desktop-atspi.js";
import { HttpTransport } from "./adapters/http.js";
import { SubprocessTransport } from "./adapters/subprocess.js";
import { CdpBrowserTransport } from "./adapters/cdp-browser.js";
import type {
  TransportAdapter,
  TransportBus,
  TransportContext,
  TransportKind,
} from "./types.js";

// Re-export the full transport type surface so `@zenalexa/unicli/transport`
// is a one-stop shop for plugin authors building custom TransportAdapters.
export type {
  TransportAdapter,
  TransportBus,
  TransportContext,
  TransportKind,
  Snapshot,
  SnapshotFormat,
  ActionRequest,
  ActionResult,
  Capability,
  TransportEvent,
} from "./types.js";

/**
 * Typed error thrown by {@link TransportBus.require} when no registered
 * transport can execute the requested step on the given platform. The
 * `envelope` field is the machine-readable payload callers should emit
 * to stderr.
 */
export class NoTransportForStepError extends Error {
  readonly envelope: EnvelopeErr;
  constructor(envelope: EnvelopeErr) {
    super(envelope.error.reason);
    this.name = "NoTransportForStepError";
    this.envelope = envelope;
  }
}

/** Implementation of the {@link TransportBus} interface. */
class TransportBusImpl implements TransportBus {
  private readonly adapters = new Map<TransportKind, TransportAdapter>();

  register(adapter: TransportAdapter): void {
    this.adapters.set(adapter.kind, adapter);
  }

  get(kind: TransportKind): TransportAdapter {
    const a = this.adapters.get(kind);
    if (!a) {
      throw new NoTransportForStepError(
        err({
          transport: kind,
          step: 0,
          action: "<bus.get>",
          reason: `no transport registered for kind ${kind}`,
          suggestion: `register a ${kind} adapter on the bus before requesting it`,
          minimum_capability: `${kind}.register`,
        }),
      );
    }
    return a;
  }

  list(): TransportAdapter[] {
    return Array.from(this.adapters.values());
  }

  require(step: string, platform?: NodeJS.Platform): TransportAdapter {
    const row = CAPABILITY_MATRIX[step];
    const hostPlatform = platform ?? process.platform;

    if (!row) {
      throw new NoTransportForStepError(
        err({
          transport: "http",
          step: 0,
          action: step,
          reason: `unknown step "${step}" — not present in capability matrix`,
          suggestion: `check the 49-step matrix in src/transport/capability.ts or rename the step`,
          minimum_capability: `unknown.${step}`,
        }),
      );
    }

    // Platform gate — a step marked ◐darwin must run on darwin.
    if (
      row.platforms &&
      !row.platforms.includes(hostPlatform as "darwin" | "win32" | "linux")
    ) {
      const requiredTransport = row.transports[0] ?? "http";
      throw new NoTransportForStepError(
        err({
          transport: requiredTransport,
          step: 0,
          action: step,
          reason: `no transport for step ${step} on platform ${hostPlatform}`,
          suggestion: `step requires ${row.platforms.join(" | ")}; run on that host or use a fallback transport`,
          minimum_capability: `${requiredTransport}.${step}`,
          exit_code: 69, // SERVICE_UNAVAILABLE — OS-gated
        }),
      );
    }

    // Walk the matrix in declaration order; pick the first registered
    // transport that declares support for the step.
    for (const kind of row.transports) {
      const adapter = this.adapters.get(kind);
      if (adapter && adapter.capability.steps.includes(step)) return adapter;
    }

    // Fallback: maybe a registered transport declares this step even if the
    // matrix is tighter. Walk every registered transport and match.
    for (const adapter of this.adapters.values()) {
      if (adapter.capability.steps.includes(step)) {
        if (
          !row.platforms ||
          row.platforms.includes(hostPlatform as "darwin" | "win32" | "linux")
        ) {
          return adapter;
        }
      }
    }

    const requiredTransport = row.transports[0] ?? "http";
    throw new NoTransportForStepError(
      err({
        transport: requiredTransport,
        step: 0,
        action: step,
        reason: `no transport for step ${step} on platform ${hostPlatform}`,
        suggestion: `register one of [${row.transports.join(", ")}] on the bus`,
        minimum_capability: `${requiredTransport}.${step}`,
      }),
    );
  }
}

/** Factory — callers create one bus per pipeline run. */
export function createTransportBus(): TransportBus {
  return new TransportBusImpl();
}

// Re-export for downstream callers that want a single import point.
export { stepPlatform, stepSupportedBy };

// --- Shared bus lifecycle -------------------------------------------------

let sharedBus: TransportBus | undefined;

/**
 * Process-wide shared bus used by the YAML runner and available to
 * plugins for registering additional {@link TransportAdapter}s.
 *
 * First call constructs a bus pre-populated with the seven built-in
 * transports (HTTP, CDP, subprocess, desktop AX/UIA/AT-SPI, CUA).
 * Subsequent calls return the same instance. Calling `register()` on
 * the returned bus is the supported plugin extension point:
 *
 * ```ts
 * import { getBus } from "@zenalexa/unicli/transport";
 * getBus().register(new MyCustomTransport());
 * ```
 */
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

/**
 * @internal Test-only hook — resets the shared bus so subsequent
 * `getBus()` calls construct a fresh instance. Not part of the public
 * plugin surface; the underscore prefix signals internal use.
 */
export function _resetTransportBusForTests(): void {
  sharedBus = undefined;
}

/**
 * Minimal slice of runner state needed to assemble a
 * {@link TransportContext}. Kept structural so this module stays
 * independent of `engine/executor` (no reverse dependency).
 */
export interface TransportCtxInput {
  cookieHeader?: string;
  vars: Record<string, unknown>;
}

/** Build a {@link TransportContext} for a dispatched step. */
export function buildTransportCtx(ctx: TransportCtxInput): TransportContext {
  return {
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    cookieHeader: ctx.cookieHeader,
    vars: ctx.vars,
    bus: getBus(),
  };
}
