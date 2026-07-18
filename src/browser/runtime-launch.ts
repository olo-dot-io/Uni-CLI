/**
 * @owner       src/browser/runtime-launch.ts
 * @does        Probe or start the single Browser Runtime Broker service without starting a browser provider.
 * @needs       node:child_process types, node:crypto, node:fs, node:path, node:url, the compiled runtime-broker-main.js artifact, src/browser/runtime-protocol.ts, runtime-transport.ts, src/transport/process-owner.ts
 * @feeds       src/browser/bridge.ts, native-host-main.ts, browser lifecycle CLI and MCP calls
 * @breaks      BrowserRuntimeLaunchError when the compiled broker artifact is absent, the broker cannot become ready inside the caller budget, or its abandoned child cannot be contained; invalid/auth/protocol endpoints fail closed.
 * @invariants  Auto-start executes a compiled broker artifact from the installed dist tree or repository build output, never a development-only transpiler; one real in-flight child attempt is shared per runtime root while each caller retains an independent startup budget and operation timeout; readiness belongs to a candidate only when the broker status PID matches its command PID; a candidate exit is not a global failure because it can mean another process won the kernel lock; observing another winner contains the local candidate before returning; a short waiter cannot retire a launch used by a longer waiter; the last unsuccessful waiter removes and terminates the exact owned process tree before another spawn; provider processes remain lazy.
 * @side-effects May spawn and terminate one owned broker process tree and create its owner-only runtime endpoint files.
 * @perf        Existing brokers require one status IPC; cold start polls locally at 50 ms intervals.
 * @concurrency In-process callers share one promise; cross-process races are resolved by the broker's exclusive lock and converge on one endpoint.
 * @test        tests/unit/browser-runtime-launch-lifecycle.test.ts, tests/integration/browser-runtime-autostart.test.ts, tests/integration/browser-native-host.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { BrowserBrokerStatus } from "./runtime-protocol.js";
import {
  BrokerTransportError,
  BrowserRuntimeBrokerClient,
  browserBrokerPaths,
} from "./runtime-transport.js";
import {
  spawnOwnedProcess,
  terminateOwnedProcess,
  type OwnedProcessLaunch,
} from "../transport/process-owner.js";

export interface BrowserRuntimeLaunchOptions {
  runtimeRoot?: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
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
interface BrokerLaunchAttempt {
  child: ChildProcess;
  spawnFailure: Promise<never>;
  addWaiter(): symbol;
  releaseWaiter(waiter: symbol): Promise<void>;
  observeReady(brokerPid: number): Promise<boolean>;
}

const launchAttempts = new Map<string, BrokerLaunchAttempt>();
const launchRetirements = new Map<string, Promise<void>>();

export async function probeBrowserRuntimeBroker(
  options: BrowserRuntimeLaunchOptions = {},
): Promise<BrowserRuntimeConnection> {
  const client = new BrowserRuntimeBrokerClient({
    runtimeRoot: options.runtimeRoot,
    requestTimeoutMs: options.requestTimeoutMs,
  });
  const status = await brokerStatus(client);
  return { client, status, spawned: false };
}

export function ensureBrowserRuntimeBroker(
  options: BrowserRuntimeLaunchOptions = {},
): Promise<BrowserRuntimeConnection> {
  return ensureBroker(options);
}

async function ensureBroker(
  options: BrowserRuntimeLaunchOptions,
): Promise<BrowserRuntimeConnection> {
  const timeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const runtimeKey = browserBrokerPaths(options.runtimeRoot).runtimeRoot;
  const client = new BrowserRuntimeBrokerClient({
    runtimeRoot: options.runtimeRoot,
    requestTimeoutMs: options.requestTimeoutMs,
  });
  try {
    const status = await brokerStatus(client);
    const spawned = await reconcileBrokerLaunch(runtimeKey, status.broker_pid);
    return { client, status, spawned };
  } catch (error) {
    if (!isUnavailable(error)) throw error;
  }

  const launch = await spawnBrokerOnce(options.runtimeRoot, runtimeKey);
  const waiter = launch.addWaiter();
  const outcome = await waitForBrokerReady(client, launch, timeoutMs).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  try {
    await launch.releaseWaiter(waiter);
  } catch (cleanupError) {
    if (outcome.ok) throw cleanupError;
    throw new BrowserRuntimeLaunchError(
      `Browser broker launch failed and its child could not be retired: ${errorMessage(cleanupError)}`,
      {
        cause: new AggregateError(
          [outcome.error, cleanupError],
          "Browser broker launch and child retirement both failed",
        ),
      },
    );
  }
  if (!outcome.ok) throw outcome.error;
  return { client, ...outcome.value };
}

async function waitForBrokerReady(
  client: BrowserRuntimeBrokerClient,
  launch: BrokerLaunchAttempt,
  timeoutMs: number,
): Promise<{ status: BrowserBrokerStatus; spawned: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const status = await brokerStatus(client);
      const spawned = await launch.observeReady(status.broker_pid);
      return { status, spawned };
    } catch (error) {
      if (!isUnavailable(error)) throw error;
      lastError = error;
    }
    await Promise.race([delay(STARTUP_POLL_MS), launch.spawnFailure]);
  }
  throw new BrowserRuntimeLaunchError(
    `Browser broker did not become ready within ${String(timeoutMs)}ms: ${errorMessage(lastError)}`,
    { cause: lastError },
  );
}

async function spawnBrokerOnce(
  runtimeRoot: string | undefined,
  key: string,
): Promise<BrokerLaunchAttempt> {
  const retirement = launchRetirements.get(key);
  if (retirement) await retirement;
  const existing = launchAttempts.get(key);
  if (existing) return existing;
  let launch: OwnedProcessLaunch;
  try {
    launch = spawnBroker(runtimeRoot);
  } catch (error) {
    throw new BrowserRuntimeLaunchError(
      `Browser broker process could not be spawned: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  const child = launch.child;
  const brokerPid = launch.commandPid;
  if (!brokerPid) {
    try {
      await terminateOwnedProcess(child);
    } catch (containmentError) {
      throw new BrowserRuntimeLaunchError(
        "Browser broker process owner omitted its command identity and could not be contained",
        { cause: containmentError },
      );
    }
    throw new BrowserRuntimeLaunchError(
      "Browser broker process owner omitted its command identity",
    );
  }
  let state: "pending" | "ready" | "retiring" | "retired" | "failed" =
    "pending";
  let retirementOperation: Promise<void> | undefined;
  const waiters = new Set<symbol>();
  let rejectFailure!: (error: BrowserRuntimeLaunchError) => void;
  const spawnFailure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  const attempt: BrokerLaunchAttempt = {
    child,
    spawnFailure,
    addWaiter(): symbol {
      const waiter = Symbol("browser-broker-launch-waiter");
      if (state === "pending") waiters.add(waiter);
      return waiter;
    },
    async releaseWaiter(waiter: symbol): Promise<void> {
      waiters.delete(waiter);
      if (state !== "pending" || waiters.size > 0) return;
      await retireCandidate("Timed-out browser broker child");
    },
    async observeReady(observedBrokerPid: number): Promise<boolean> {
      const candidateBrokerPid = await brokerPid;
      if (observedBrokerPid !== candidateBrokerPid) {
        await retireCandidate("Superseded browser broker child");
        return false;
      }
      if (state === "pending") {
        state = "ready";
        waiters.clear();
        cleanup();
        if (launchAttempts.get(key) === attempt) launchAttempts.delete(key);
      }
      return state === "ready";
    },
  };
  const retireCandidate = (label: string): Promise<void> => {
    if (retirementOperation) return retirementOperation;
    if (state !== "pending") return Promise.resolve();
    state = "retiring";
    waiters.clear();
    cleanup();
    if (launchAttempts.get(key) === attempt) launchAttempts.delete(key);
    const retirement = terminateOwnedProcess(child)
      .catch((error: unknown) => {
        throw new BrowserRuntimeLaunchError(
          `${label} ${String(child.pid ?? "unknown")} could not be terminated: ${errorMessage(error)}`,
          { cause: error },
        );
      })
      .finally(() => {
        state = "retired";
        if (launchRetirements.get(key) === retirement) {
          launchRetirements.delete(key);
        }
      });
    retirementOperation = retirement;
    launchRetirements.set(key, retirement);
    return retirement;
  };
  const cleanup = (): void => {
    child.off("error", failSpawn);
  };
  const fail = (message: string, cause?: unknown): void => {
    if (state !== "pending") return;
    state = "failed";
    waiters.clear();
    cleanup();
    if (launchAttempts.get(key) === attempt) launchAttempts.delete(key);
    rejectFailure(new BrowserRuntimeLaunchError(message, { cause }));
  };
  const failSpawn = (error: Error): void => {
    fail(`Browser broker process failed to spawn: ${error.message}`, error);
  };
  child.once("error", failSpawn);
  launchAttempts.set(key, attempt);
  void spawnFailure.catch(() => undefined);
  child.unref();
  return attempt;
}

async function reconcileBrokerLaunch(
  key: string,
  brokerPid: number,
): Promise<boolean> {
  const launch = launchAttempts.get(key);
  return launch ? await launch.observeReady(brokerPid) : false;
}

function spawnBroker(runtimeRoot?: string): OwnedProcessLaunch {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const installedBrokerPath = join(moduleDirectory, "runtime-broker-main.js");
  const repositoryBrokerPath = join(
    moduleDirectory,
    "..",
    "..",
    "dist",
    "browser",
    "runtime-broker-main.js",
  );
  const brokerPath = [installedBrokerPath, repositoryBrokerPath].find(
    existsSync,
  );
  if (!brokerPath) {
    throw new BrowserRuntimeLaunchError(
      `Browser broker build artifact is missing at ${repositoryBrokerPath}. Run \`npm run build\` before source-mode browser commands.`,
    );
  }
  return spawnOwnedProcess(process.execPath, [brokerPath], {
    stdio: "ignore",
    reportPath: join(
      tmpdir(),
      `unicli-broker-owner-${String(process.pid)}-${randomUUID()}.json`,
    ),
    env: {
      ...process.env,
      ...(runtimeRoot ? { UNICLI_BROWSER_RUNTIME_DIR: runtimeRoot } : {}),
    },
  });
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
