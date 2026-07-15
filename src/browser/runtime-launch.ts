/**
 * @owner       src/browser/runtime-launch.ts
 * @does        Probe or start the single Browser Runtime Broker service without starting a browser provider.
 * @needs       node:child_process, node:crypto, node:fs, node:module, node:path, node:url, src/browser/runtime-protocol.ts, runtime-transport.ts
 * @feeds       src/browser/bridge.ts, native-host-main.ts, browser lifecycle CLI and MCP calls
 * @breaks      BrowserRuntimeLaunchError when the broker cannot become ready inside the caller budget; invalid/auth/protocol endpoints fail closed.
 * @invariants  Auto-start occurs only after an unavailable probe; one in-process launch is coalesced per runtime root; provider processes remain lazy.
 * @side-effects May spawn one detached broker process and create its owner-only runtime endpoint files.
 * @perf        Existing brokers require one status IPC; cold start polls locally at 50 ms intervals.
 * @concurrency In-process callers share one promise; cross-process races are resolved by the broker's exclusive lock and converge on one endpoint.
 * @test        tests/integration/browser-runtime-autostart.test.ts, tests/integration/browser-native-host.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { BrowserBrokerStatus } from "./runtime-protocol.js";
import {
  BrokerTransportError,
  BrowserRuntimeBrokerClient,
  browserBrokerPaths,
} from "./runtime-transport.js";

export interface BrowserRuntimeLaunchOptions {
  runtimeRoot?: string;
  timeoutMs?: number;
}

export interface BrowserRuntimeConnection {
  client: BrowserRuntimeBrokerClient;
  status: BrowserBrokerStatus;
  spawned: boolean;
}

export class BrowserRuntimeLaunchError extends Error {
  readonly code = "browser_broker_start_failed";
  readonly retryable = true;
  readonly suggestion =
    "Run `unicli browser doctor --json` and inspect the broker endpoint and startup evidence.";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrowserRuntimeLaunchError";
  }
}

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const STARTUP_POLL_MS = 50;
const launches = new Map<string, Promise<BrowserRuntimeConnection>>();
const require = createRequire(import.meta.url);

export async function probeBrowserRuntimeBroker(
  options: BrowserRuntimeLaunchOptions = {},
): Promise<BrowserRuntimeConnection> {
  const client = new BrowserRuntimeBrokerClient({
    runtimeRoot: options.runtimeRoot,
    timeoutMs: options.timeoutMs,
  });
  const status = await brokerStatus(client);
  return { client, status, spawned: false };
}

export function ensureBrowserRuntimeBroker(
  options: BrowserRuntimeLaunchOptions = {},
): Promise<BrowserRuntimeConnection> {
  const key = browserBrokerPaths(options.runtimeRoot).runtimeRoot;
  const existing = launches.get(key);
  if (existing) return existing;
  const launch = ensureBroker(options).finally(() => launches.delete(key));
  launches.set(key, launch);
  return launch;
}

async function ensureBroker(
  options: BrowserRuntimeLaunchOptions,
): Promise<BrowserRuntimeConnection> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const client = new BrowserRuntimeBrokerClient({
    runtimeRoot: options.runtimeRoot,
    timeoutMs,
  });
  try {
    return { client, status: await brokerStatus(client), spawned: false };
  } catch (error) {
    if (!isUnavailable(error)) throw error;
  }

  spawnBroker(options.runtimeRoot);
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const status = await brokerStatus(client);
      return { client, status, spawned: true };
    } catch (error) {
      if (!isUnavailable(error)) throw error;
      lastError = error;
    }
    await delay(STARTUP_POLL_MS);
  }
  throw new BrowserRuntimeLaunchError(
    `Browser broker did not become ready within ${String(timeoutMs)}ms: ${errorMessage(lastError)}`,
    { cause: lastError },
  );
}

function spawnBroker(runtimeRoot?: string): void {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const compiledPath = join(moduleDirectory, "runtime-broker-main.js");
  const sourcePath = join(moduleDirectory, "runtime-broker-main.ts");
  const args = existsSync(compiledPath)
    ? [compiledPath]
    : ["--import", pathToFileURL(require.resolve("tsx")).href, sourcePath];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ...(runtimeRoot ? { UNICLI_BROWSER_RUNTIME_DIR: runtimeRoot } : {}),
    },
  });
  child.unref();
}

function brokerStatus(
  client: BrowserRuntimeBrokerClient,
): Promise<BrowserBrokerStatus> {
  return client.requestOrThrow<BrowserBrokerStatus>({
    id: randomUUID(),
    action: "broker.status",
  });
}

function isUnavailable(error: unknown): boolean {
  return (
    error instanceof BrokerTransportError &&
    error.code === "browser_broker_unavailable"
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
