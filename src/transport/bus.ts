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
 */

import { err, type EnvelopeErr } from "../core/envelope.js";
import {
  CAPABILITY_MATRIX,
  stepPlatform,
  stepSupportedBy,
} from "./capability.js";
import type { TransportAdapter, TransportBus, TransportKind } from "./types.js";

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
