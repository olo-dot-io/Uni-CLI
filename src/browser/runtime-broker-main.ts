/**
 * @owner       src/browser/runtime-broker-main.ts
 * @does        Run one long-lived Browser Runtime Broker process and coordinate authenticated transport, TTL reaping, signals, and complete shutdown.
 * @needs       node:crypto, src/browser/runtime-broker.ts, runtime-protocol.ts, runtime-transport.ts
 * @feeds       unicli browser broker lifecycle, lazy BrowserBridge auto-start, native host, and integration tests
 * @breaks      Exits nonzero after emitting a structured error when configuration, transport startup, reaping, or shutdown fails.
 * @invariants  One process owns one broker transport; shutdown rejects ordinary Agent work but preserves the authenticated Chrome host cleanup lane until sessions, targets, and providers finish teardown, then releases descriptors, sockets, and locks.
 * @side-effects Creates the broker endpoint, starts browser providers lazily, installs signal handlers and a reaper timer, and writes failures to stderr.
 * @perf        Idle process cost is one bounded periodic session scan; page work is event-driven.
 * @concurrency Shutdown is idempotent; broker admission and provider teardown precede transport close so native-host cleanup can progress.
 * @test        tests/integration/browser-runtime-broker.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import { randomUUID } from "node:crypto";

import { BrowserRuntimeBroker } from "./runtime-broker.js";
import { BROWSER_BROKER_DEFAULT_SESSION_TTL_MS } from "./runtime-protocol.js";
import { BrowserRuntimeBrokerServer } from "./runtime-transport.js";

const runtimeId = randomUUID();
let broker: BrowserRuntimeBroker | null = null;
let server: BrowserRuntimeBrokerServer | null = null;
let shutdownPromise: Promise<void> | null = null;
let reaper: ReturnType<typeof setInterval> | null = null;

async function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    if (reaper) {
      clearInterval(reaper);
      reaper = null;
    }
    let shutdownError: unknown;
    broker?.beginShutdown();
    try {
      await broker?.close();
    } catch (error) {
      shutdownError = error;
    }
    try {
      await server?.stop();
    } catch (error) {
      shutdownError ??= error;
    }
    if (shutdownError) throw shutdownError;
  })();
  return shutdownPromise;
}

function requestSignalShutdown(signal: NodeJS.Signals): void {
  shutdown()
    .then(() => {
      process.exitCode = 0;
    })
    .catch((error) => {
      writeFatalError("browser_broker_shutdown_failed", error, { signal });
      process.exitCode = 1;
    });
}

function readNonNegativeInteger(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer, received ${raw}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} exceeds JavaScript's safe integer range`);
  }
  return parsed;
}

function writeFatalError(
  code: string,
  error: unknown,
  metadata: Record<string, unknown> = {},
): void {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      error: {
        code,
        message: error instanceof Error ? error.message : String(error),
        suggestion:
          "Run `unicli browser doctor --json` and inspect the broker/runtime evidence.",
        retryable: false,
        ...metadata,
      },
    })}\n`,
  );
}

async function main(): Promise<void> {
  const sessionTtlMs = readNonNegativeInteger(
    "UNICLI_BROWSER_SESSION_TTL_MS",
    BROWSER_BROKER_DEFAULT_SESSION_TTL_MS,
  );
  const runtimeBroker = new BrowserRuntimeBroker({ runtimeId, sessionTtlMs });
  broker = runtimeBroker;
  server = new BrowserRuntimeBrokerServer({
    runtimeId,
    handler: (request, signal) => runtimeBroker.dispatch(request, signal),
    onShutdown: () => shutdown(),
  });
  const descriptor = await server.start();
  const reapIntervalMs = Math.max(
    1_000,
    Math.min(30_000, Math.ceil(sessionTtlMs / 2)),
  );
  reaper = setInterval(() => {
    runtimeBroker.reapIdleSessions().catch((error) => {
      writeFatalError("browser_session_reap_failed", error);
      process.exitCode = 1;
    });
  }, reapIntervalMs);
  reaper.unref();
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      runtime_id: descriptor.runtime_id,
      pid: descriptor.pid,
      socket_path: descriptor.socket_path,
    })}\n`,
  );
}

process.once("SIGINT", () => requestSignalShutdown("SIGINT"));
process.once("SIGTERM", () => requestSignalShutdown("SIGTERM"));

main().catch(async (error) => {
  writeFatalError("browser_broker_start_failed", error);
  try {
    await shutdown();
  } catch (shutdownError) {
    writeFatalError("browser_broker_shutdown_failed", shutdownError);
  }
  process.exitCode = 1;
});
