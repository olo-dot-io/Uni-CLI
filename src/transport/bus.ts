/**
 * TransportBus — composition layer that routes a pipeline step to the
 * transport that can execute it on the current host.
 * @owner       src::transport::bus
 * @does        Own exact transport registration, reject ambiguous step-only selection, and build request-scoped transport context for pipelines.
 * @needs       transport adapters, capability matrix, refs, core envelopes.
 * @feeds       engine steps, compute CLI, plugin transport registration.
 * @breaks      NoTransportForStepError when capability routing cannot select exactly one adapter.
 * @invariants  Step-only lookup succeeds for one provider and rejects multiple providers; the shared adapter registry never owns per-request cancellation or Agent identity.
 * @side-effects Lazily constructs process-shared adapters and reads cwd/environment when building context.
 * @perf        O(number of candidate transports) routing.
 * @concurrency Shared adapters receive independent request contexts; per-request state must not be stored globally.
 * @test        tests/unit/transport/*.test.ts, tests/unit/engine/executor.test.ts
 * @stability   stable
 * @since       2026-06-29
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
import { VisualTransport } from "./adapters/visual.js";
import { DesktopAxTransport } from "./adapters/desktop-ax.js";
import { DesktopUiaTransport } from "./adapters/desktop-uia.js";
import { DesktopAtspiTransport } from "./adapters/desktop-atspi.js";
import { HttpTransport } from "./adapters/http.js";
import { SubprocessTransport } from "./adapters/subprocess.js";
import { CdpBrowserTransport } from "./adapters/cdp-browser.js";
import { CuaDriverTransport } from "./adapters/cua-driver.js";
import { RefStore } from "./refs.js";
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
export {
  RefAllocator,
  RefStore,
  type ElementRef,
  type RefBucket,
} from "./refs.js";
export {
  encodeSnapshot,
  type RawAxNode,
  type SnapshotEncoding,
} from "./snapshot-encoder.js";

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
  readonly refs = new RefStore();
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
          suggestion: "check src/transport/capability.ts or rename the step",
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
          suggestion: `step requires ${row.platforms.join(" | ")}; run on that host or select another declared operation`,
          minimum_capability: `${requiredTransport}.${step}`,
          exit_code: 69, // SERVICE_UNAVAILABLE — OS-gated
        }),
      );
    }

    const candidates = row.transports.flatMap((kind) => {
      const adapter = this.adapters.get(kind);
      return adapter?.capability.steps.includes(step) ? [adapter] : [];
    });
    if (candidates.length === 1 && candidates[0]) {
      return candidates[0];
    }
    if (candidates.length > 1) {
      const kinds = candidates.map((candidate) => candidate.kind);
      throw new NoTransportForStepError(
        err({
          transport: kinds[0] ?? "http",
          step: 0,
          action: step,
          reason: `ambiguous transport for step ${step}: ${kinds.join(", ")}`,
          suggestion:
            "select a provider from the task contract, then call bus.get(kind)",
          minimum_capability: `route.${step}.provider_required`,
        }),
      );
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
const namespacedBuses = new Map<string, TransportBus>();
const MAX_REF_NAMESPACES = 512;

/**
 * Process-wide shared bus used by the YAML runner and available to
 * plugins for registering additional {@link TransportAdapter}s.
 *
 * First call constructs a bus pre-populated with the built-in transports
 * (HTTP, CDP, subprocess, desktop AX/UIA/AT-SPI, optional Cua Driver, Visual).
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
  bus.register(new CuaDriverTransport());
  bus.register(new VisualTransport());
  sharedBus = bus;
  return bus;
}

/**
 * Return a transport bus whose ref authority is isolated to one trusted
 * principal/session namespace while sharing the process-wide adapter set.
 */
export function getNamespacedBus(namespace: string): TransportBus {
  const normalized = namespace.trim();
  if (!normalized || normalized.length > 512 || /\p{Cc}/u.test(normalized)) {
    throw new TypeError("transport ref namespace must be a bounded identity");
  }
  const adapters = getBus().list();
  const existing = namespacedBuses.get(normalized);
  if (existing) {
    for (const adapter of adapters) existing.register(adapter);
    return existing;
  }
  if (namespacedBuses.size >= MAX_REF_NAMESPACES) {
    throw new Error(
      `transport ref namespace capacity reached (${MAX_REF_NAMESPACES}); close an inactive MCP session before admitting another namespace`,
    );
  }
  const bus = createTransportBus();
  for (const adapter of adapters) bus.register(adapter);
  namespacedBuses.set(normalized, bus);
  return bus;
}

export function releaseTransportBusNamespace(namespace: string): void {
  const bus = namespacedBuses.get(namespace);
  bus?.refs.clear();
  namespacedBuses.delete(namespace);
}

export function releaseAllTransportBusNamespaces(): void {
  for (const bus of namespacedBuses.values()) bus.refs.clear();
  namespacedBuses.clear();
}

/**
 * @internal Test-only hook — resets the shared bus so subsequent
 * `getBus()` calls construct a fresh instance. Not part of the public
 * plugin surface; the underscore prefix signals internal use.
 */
export function _resetTransportBusForTests(): void {
  sharedBus = undefined;
  releaseAllTransportBusNamespaces();
}

/**
 * Minimal slice of runner state needed to assemble a
 * {@link TransportContext}. Kept structural so this module stays
 * independent of `engine/executor` (no reverse dependency).
 */
export interface TransportCtxInput {
  cookieHeader?: string;
  vars: Record<string, unknown>;
  signal?: AbortSignal;
}

/** Build a {@link TransportContext} for a dispatched step. */
export function buildTransportCtx(ctx: TransportCtxInput): TransportContext {
  const bus = getBus();
  return {
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    cookieHeader: ctx.cookieHeader,
    vars: ctx.vars,
    signal: ctx.signal,
    bus,
    refs: bus.refs,
  };
}
