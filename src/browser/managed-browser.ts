/**
 * @owner       src/browser/managed-browser.ts
 * @does        Own lazy headless Chromium processes, profile partitions, browser contexts, page targets, crash recovery, and shutdown.
 * @needs       node:child_process types/inspection, node:crypto, node:fs, node:path, src/browser/cdp-client.ts, launcher.ts, local-profiles.ts, page.ts, profile-seed.ts, src/engine/user-home.ts, src/transport/process-owner.ts
 * @feeds       src/browser/runtime-broker.ts
 * @breaks      ManagedBrowserError on unavailable binaries/profiles, conflicting partition policy, startup failure, stale runtime identity, CDP failure, and teardown failure.
 * @invariants  One process owner writes a profile partition; every leased page has a distinct target; failed isolated allocation disposes its BrowserContext when its identity is known, while an ambiguous allocation retires the whole runtime before returning; target/context teardown converges by post-command inventory even when an ACK is lost; hidden runtimes always use headless=new with an explicit about:blank startup target so Chromium publishes DevToolsActivePort; stale runtimes are retired before replacement; browser PIDs are identity evidence and never cleanup authority; runtime evidence and ephemeral profiles are removed only after the persisted POSIX process group or Windows Job owner is absent; crash recovery discards targets whose leases died with the broker.
 * @side-effects Creates mode-restricted runtime/profile files, spawns or recovers Chromium, opens CDP sockets, and closes targets/processes.
 * @perf        Browser launch is lazy; runtime liveness transitions are coalesced per partition; target allocation is one browser-level CDP call plus one target WebSocket.
 * @concurrency Concurrent liveness checks, stale-runtime retirement, and launches for one partition share one transition; distinct partitions and targets progress independently.
 * @test        tests/integration/browser-runtime-broker.test.ts, browser-runtime-isolation.test.ts, managed-browser-lifecycle.test.ts, including crash recovery and forced process termination
 * @stability   experimental
 * @since       2026-07-15
 */

import { execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { CDPClient, CDPCommandTransportError } from "./cdp-client.js";
import { findChrome } from "./launcher.js";
import {
  resolveLocalBrowserProfile,
  resolvePreferredLocalBrowserProfile,
  type LocalBrowserProfile,
} from "./local-profiles.js";
import { BrowserPage } from "./page.js";
import { prepareSeededAutomationProfile } from "./profile-seed.js";
import { userHome } from "../engine/user-home.js";
import {
  processOwnerExists,
  spawnOwnedProcess,
  terminateOwnedProcess,
  terminateProcessOwner,
  type ProcessOwnerIdentity,
} from "../transport/process-owner.js";

export interface ManagedBrowserTargetRequest {
  profile_partition_id: string;
  isolated: boolean;
  ephemeral: boolean;
  profile_id?: string;
}

export interface ManagedBrowserTarget {
  target_id: string;
  browser_context_id?: string;
  page: BrowserPage;
  runtime: ManagedBrowserRuntimeStatus;
}

export interface ManagedBrowserRuntimeStatus {
  runtime_id: string;
  provider: "managed";
  profile_partition_id: string;
  profile_source: "ephemeral" | "seeded";
  profile_id?: string;
  browser_pid: number;
  process_owner: ProcessOwnerIdentity;
  broker_pid: number;
  cdp_port: number;
  user_data_dir: string;
  visibility: "hidden";
  target_count: number;
  recovered: boolean;
}

interface ManagedBrowserProviderOptions {
  runtimeRoot?: string;
  browserPath?: string;
  startupTimeoutMs?: number;
  brokerRuntimeId?: string;
  env?: NodeJS.ProcessEnv;
}

interface RuntimeDescriptor {
  version: 2;
  runtime_id: string;
  broker_runtime_id: string;
  profile_partition_id: string;
  profile_source: "ephemeral" | "seeded";
  profile_id?: string;
  browser_pid: number;
  process_owner: ProcessOwnerIdentity;
  cdp_port: number;
  user_data_dir: string;
  browser_path: string;
  started_at: string;
}

interface ManagedRuntime {
  descriptor: RuntimeDescriptor;
  browserClient: CDPClient;
  child?: ChildProcess;
  recovered: boolean;
  retiring: boolean;
  targets: Map<string, ManagedTargetRecord>;
}

interface ManagedTargetRecord {
  page: BrowserPage;
  browserContextId?: string;
  pageClosed: boolean;
  targetClosed: boolean;
  contextDisposed: boolean;
}

type ManagedBrowserErrorCode =
  | "browser_binary_unavailable"
  | "browser_profile_unavailable"
  | "browser_partition_conflict"
  | "browser_runtime_start_failed"
  | "browser_runtime_shutdown_failed"
  | "browser_runtime_identity_invalid"
  | "browser_target_not_found";

const RUNTIME_DESCRIPTOR_VERSION = 2;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const STARTUP_POLL_MS = 100;
const TARGET_CLOSE_TIMEOUT_MS = 5_000;
const MAX_STARTUP_STDERR_BYTES = 16 * 1024;

export class ManagedBrowserError extends Error {
  readonly retryable: boolean;
  readonly suggestion: string;

  constructor(
    readonly code: ManagedBrowserErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ManagedBrowserError";
    this.retryable = code === "browser_runtime_start_failed";
    this.suggestion = managedBrowserSuggestion(code);
  }
}

export class ManagedBrowserProvider {
  private readonly runtimeRoot: string;
  private readonly browserPath?: string;
  private readonly startupTimeoutMs: number;
  private readonly brokerRuntimeId: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly runtimes = new Map<string, ManagedRuntime>();
  private readonly runtimeTransitions = new Map<
    string,
    Promise<ManagedRuntime>
  >();

  constructor(options: ManagedBrowserProviderOptions = {}) {
    this.env = options.env ?? process.env;
    this.runtimeRoot =
      options.runtimeRoot ??
      this.env.UNICLI_BROWSER_RUNTIME_DIR ??
      join(userHome(), ".unicli", "browser-runtime");
    this.browserPath = options.browserPath ?? this.env.CHROME_PATH;
    this.startupTimeoutMs =
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.brokerRuntimeId = options.brokerRuntimeId ?? randomUUID();
  }

  async acquireTarget(
    request: ManagedBrowserTargetRequest,
    signal?: AbortSignal,
  ): Promise<ManagedBrowserTarget> {
    validateTargetRequest(request);
    signal?.throwIfAborted();
    const runtime = await this.ensureRuntime(request);
    signal?.throwIfAborted();
    let browserContextId: string | undefined;
    let targetId: string | undefined;
    let allocationStage: "context" | "target" | "connect" = request.isolated
      ? "context"
      : "target";
    try {
      browserContextId = request.isolated
        ? await createBrowserContext(runtime.browserClient, signal)
        : undefined;
      signal?.throwIfAborted();
      allocationStage = "target";
      targetId = await createPageTarget(
        runtime.browserClient,
        browserContextId,
        signal,
      );
      signal?.throwIfAborted();
      allocationStage = "connect";
      const client = await connectTargetWithRetry(
        targetId,
        runtime.descriptor.cdp_port,
        this.startupTimeoutMs,
        signal,
      );
      signal?.throwIfAborted();
      const page = new BrowserPage(client);
      runtime.targets.set(targetId, {
        page,
        ...(browserContextId ? { browserContextId } : {}),
        pageClosed: false,
        targetClosed: false,
        contextDisposed: browserContextId === undefined,
      });
      return {
        target_id: targetId,
        ...(browserContextId ? { browser_context_id: browserContextId } : {}),
        page,
        runtime: runtimeStatus(runtime),
      };
    } catch (error) {
      if (
        allocationStage !== "connect" &&
        allocationOutcomeIsAmbiguous(error)
      ) {
        runtime.retiring = true;
        try {
          await this.ensureRuntime(request);
        } catch (retirementError) {
          throw new ManagedBrowserError(
            "browser_runtime_shutdown_failed",
            `Managed target allocation became ambiguous and runtime ${runtime.descriptor.runtime_id} could not be retired cleanly`,
            {
              cause: new AggregateError(
                [error, retirementError],
                "Ambiguous managed allocation and runtime retirement failed",
              ),
            },
          );
        }
        throw error;
      }
      const cleanupErrors: unknown[] = [];
      if (targetId) {
        try {
          await closeTargetIfPresent(runtime.browserClient, targetId);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (browserContextId) {
        try {
          await disposeBrowserContext(runtime.browserClient, browserContextId);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new ManagedBrowserError(
          "browser_runtime_shutdown_failed",
          `Managed target allocation failed and cleanup was incomplete: ${errorMessage(cleanupErrors[0])}`,
          {
            cause: new AggregateError(
              [error, ...cleanupErrors],
              "Managed target allocation and cleanup failed",
            ),
          },
        );
      }
      throw error;
    }
  }

  getPage(targetId: string): BrowserPage {
    for (const runtime of this.runtimes.values()) {
      const target = runtime.targets.get(targetId);
      if (target) return target.page;
    }
    throw new ManagedBrowserError(
      "browser_target_not_found",
      `Managed browser target not found: ${targetId}`,
    );
  }

  async releaseTarget(targetId: string): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      if (runtime.targets.has(targetId)) {
        await this.releaseRuntimeTarget(runtime, targetId);
        return;
      }
    }
  }

  status(): ManagedBrowserRuntimeStatus[] {
    return [...this.runtimes.values()]
      .map(runtimeStatus)
      .sort((left, right) =>
        left.profile_partition_id.localeCompare(right.profile_partition_id),
      );
  }

  async close(): Promise<void> {
    let closeError: unknown;
    const transitioning = await Promise.allSettled(
      this.runtimeTransitions.values(),
    );
    closeError = transitioning.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )?.reason;
    const runtimes = [...this.runtimes.values()];
    for (const runtime of runtimes) {
      try {
        await this.closeRuntime(runtime);
        this.runtimes.delete(runtime.descriptor.profile_partition_id);
      } catch (error) {
        closeError ??= error;
      }
    }
    if (closeError) {
      throw closeError instanceof ManagedBrowserError
        ? closeError
        : new ManagedBrowserError(
            "browser_runtime_shutdown_failed",
            `Managed browser provider did not close cleanly: ${errorMessage(closeError)}`,
            { cause: closeError },
          );
    }
  }

  private async ensureRuntime(
    request: ManagedBrowserTargetRequest,
  ): Promise<ManagedRuntime> {
    const partitionId = request.profile_partition_id;
    const inFlight = this.runtimeTransitions.get(partitionId);
    if (inFlight) {
      const runtime = await inFlight;
      assertRuntimePolicy(runtime.descriptor, request);
      return runtime;
    }
    const transition = this.resolveRuntime(request);
    this.runtimeTransitions.set(partitionId, transition);
    try {
      const runtime = await transition;
      assertRuntimePolicy(runtime.descriptor, request);
      return runtime;
    } finally {
      if (this.runtimeTransitions.get(partitionId) === transition) {
        this.runtimeTransitions.delete(partitionId);
      }
    }
  }

  private async resolveRuntime(
    request: ManagedBrowserTargetRequest,
  ): Promise<ManagedRuntime> {
    const partitionId = request.profile_partition_id;
    const existing = this.runtimes.get(partitionId);
    if (existing) {
      assertRuntimePolicy(existing.descriptor, request);
      if (!existing.retiring && (await runtimeIsLive(existing))) {
        return existing;
      }
      existing.retiring = true;
      await this.closeRuntime(existing);
      if (this.runtimes.get(partitionId) === existing) {
        this.runtimes.delete(partitionId);
      }
    }
    const runtime = await this.openRuntime(request);
    this.runtimes.set(partitionId, runtime);
    return runtime;
  }

  private async openRuntime(
    request: ManagedBrowserTargetRequest,
  ): Promise<ManagedRuntime> {
    const paths = runtimePaths(this.runtimeRoot, request.profile_partition_id);
    mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
    chmodSync(paths.runtimeDir, 0o700);
    const recovered = await recoverRuntime(
      paths.descriptorPath,
      request,
      this.brokerRuntimeId,
    );
    if (recovered) return recovered;

    const profile = request.ephemeral
      ? null
      : resolveRequestedProfile(request.profile_id, this.env);
    const browserPath =
      this.browserPath ??
      (profile?.browser_path_exists ? profile.browser_path : undefined) ??
      findChrome() ??
      undefined;
    if (!browserPath) {
      throw new ManagedBrowserError(
        "browser_binary_unavailable",
        "No Chromium browser executable is available for the managed hidden provider",
      );
    }

    const userDataDir = request.ephemeral
      ? createEphemeralProfile(paths.runtimeDir)
      : await preparePersistentProfile(paths.profileDir, profile!);
    let launched: Awaited<ReturnType<typeof launchHeadlessBrowser>>;
    try {
      launched = await launchHeadlessBrowser({
        browserPath,
        userDataDir,
        profileDirectory: profile?.profile_dir,
        startupTimeoutMs: this.startupTimeoutMs,
        ownerReportPath: paths.ownerReportPath,
      });
    } catch (error) {
      if (
        request.ephemeral &&
        !isManagedBrowserError(error, "browser_runtime_shutdown_failed")
      ) {
        try {
          rmSync(userDataDir, { recursive: true, force: true });
        } catch (cleanupError) {
          throw new ManagedBrowserError(
            "browser_runtime_shutdown_failed",
            `Headless Chromium startup failed and its ephemeral profile could not be removed: ${errorMessage(cleanupError)}`,
            {
              cause: new AggregateError(
                [error, cleanupError],
                "Managed browser startup and profile cleanup failed",
              ),
            },
          );
        }
      }
      throw error;
    }
    const descriptor: RuntimeDescriptor = {
      version: RUNTIME_DESCRIPTOR_VERSION,
      runtime_id: randomUUID(),
      broker_runtime_id: this.brokerRuntimeId,
      profile_partition_id: request.profile_partition_id,
      profile_source: request.ephemeral ? "ephemeral" : "seeded",
      ...(profile ? { profile_id: profile.id } : {}),
      browser_pid: launched.pid,
      process_owner: launched.processOwner,
      cdp_port: launched.port,
      user_data_dir: userDataDir,
      browser_path: browserPath,
      started_at: new Date().toISOString(),
    };
    let browserClient: CDPClient | null = null;
    let descriptorWritten = false;
    try {
      writeRuntimeDescriptor(paths.descriptorPath, descriptor);
      descriptorWritten = true;
      browserClient = await CDPClient.connectToBrowser(launched.port);
      const runtime: ManagedRuntime = {
        descriptor,
        browserClient,
        child: launched.child,
        recovered: false,
        retiring: false,
        targets: new Map(),
      };
      await closeAllPageTargets(runtime.browserClient);
      return runtime;
    } catch (error) {
      const processEvidenceErrors: unknown[] = [];
      if (browserClient) {
        try {
          await browserClient.close();
        } catch (cleanupError) {
          processEvidenceErrors.push(cleanupError);
        }
      }
      try {
        await terminateOwnedProcess(launched.child);
      } catch (cleanupError) {
        throw new ManagedBrowserError(
          "browser_runtime_shutdown_failed",
          `Headless Chromium startup failed and process ${String(launched.pid)} could not be stopped; runtime evidence was retained`,
          {
            cause: new AggregateError(
              [error, ...processEvidenceErrors, cleanupError],
              "Managed browser startup and process cleanup failed",
            ),
          },
        );
      }
      const cleanupErrors: unknown[] = [];
      if (descriptorWritten) {
        try {
          removeRuntimeDescriptor(paths.descriptorPath, descriptor.runtime_id);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (request.ephemeral) {
        try {
          rmSync(userDataDir, { recursive: true, force: true });
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new ManagedBrowserError(
          "browser_runtime_shutdown_failed",
          `Headless Chromium startup failed and cleanup was incomplete: ${errorMessage(cleanupErrors[0])}`,
          {
            cause: new AggregateError(
              [error, ...cleanupErrors],
              "Managed browser startup and cleanup failed",
            ),
          },
        );
      }
      throw new ManagedBrowserError(
        "browser_runtime_start_failed",
        `Headless Chromium exposed port ${String(launched.port)} but browser-level CDP setup failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private async closeRuntime(runtime: ManagedRuntime): Promise<void> {
    runtime.retiring = true;
    let shutdownError: unknown;
    const attempt = async (operation: () => Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        shutdownError ??= error;
      }
    };
    const targetIds = [...runtime.targets.keys()];
    for (const targetId of targetIds) {
      await attempt(() => this.releaseRuntimeTarget(runtime, targetId));
    }
    await attempt(() => requestBrowserClose(runtime.browserClient));
    await attempt(() => runtime.browserClient.close());
    try {
      await stopRuntimeProcess(runtime.descriptor, 5_000, runtime.child);
    } catch (error) {
      throw new ManagedBrowserError(
        "browser_runtime_shutdown_failed",
        `Managed browser runtime ${runtime.descriptor.runtime_id} remained live; runtime evidence and profile were retained`,
        {
          cause: shutdownError
            ? new AggregateError(
                [shutdownError, error],
                "Browser close and process termination failed",
              )
            : error,
        },
      );
    }
    runtime.targets.clear();
    shutdownError = undefined;
    const paths = runtimePaths(
      this.runtimeRoot,
      runtime.descriptor.profile_partition_id,
    );
    try {
      removeRuntimeDescriptor(
        paths.descriptorPath,
        runtime.descriptor.runtime_id,
      );
    } catch (error) {
      shutdownError ??= error;
    } finally {
      if (runtime.descriptor.profile_source === "ephemeral") {
        try {
          rmSync(runtime.descriptor.user_data_dir, {
            recursive: true,
            force: true,
          });
        } catch (error) {
          shutdownError ??= error;
        }
      }
    }
    if (shutdownError) {
      throw new ManagedBrowserError(
        "browser_runtime_shutdown_failed",
        `Managed browser runtime ${runtime.descriptor.runtime_id} did not shut down cleanly: ${errorMessage(shutdownError)}`,
        { cause: shutdownError },
      );
    }
  }

  private async releaseRuntimeTarget(
    runtime: ManagedRuntime,
    targetId: string,
  ): Promise<void> {
    const target = runtime.targets.get(targetId);
    if (!target) return;
    let releaseError: unknown;
    if (!target.pageClosed) {
      try {
        await target.page.close();
        target.pageClosed = true;
      } catch (error) {
        releaseError ??= error;
      }
    }
    if (!target.targetClosed) {
      try {
        await closeTargetIfPresent(runtime.browserClient, targetId);
        target.targetClosed = true;
      } catch (error) {
        releaseError ??= error;
      }
    }
    if (target.browserContextId && !target.contextDisposed) {
      try {
        await disposeBrowserContext(
          runtime.browserClient,
          target.browserContextId,
        );
        target.contextDisposed = true;
      } catch (error) {
        releaseError ??= error;
      }
    }
    if (releaseError) {
      throw new ManagedBrowserError(
        "browser_runtime_shutdown_failed",
        `Managed browser target ${targetId} did not release cleanly: ${errorMessage(releaseError)}`,
        { cause: releaseError },
      );
    }
    runtime.targets.delete(targetId);
  }
}

function validateTargetRequest(request: ManagedBrowserTargetRequest): void {
  if (!request.profile_partition_id.trim()) {
    throw new ManagedBrowserError(
      "browser_partition_conflict",
      "Managed browser profile partition id must not be empty",
    );
  }
  if (request.ephemeral && request.profile_id) {
    throw new ManagedBrowserError(
      "browser_partition_conflict",
      "An ephemeral managed browser cannot also select a persistent profile id",
    );
  }
}

function assertRuntimePolicy(
  descriptor: RuntimeDescriptor,
  request: ManagedBrowserTargetRequest,
): void {
  const expectedSource = request.ephemeral ? "ephemeral" : "seeded";
  if (
    descriptor.profile_source !== expectedSource ||
    (request.profile_id !== undefined &&
      descriptor.profile_id !== request.profile_id)
  ) {
    throw new ManagedBrowserError(
      "browser_partition_conflict",
      `Profile partition "${request.profile_partition_id}" is already bound to ${descriptor.profile_source}${descriptor.profile_id ? ` profile ${descriptor.profile_id}` : ""}`,
    );
  }
}

function resolveRequestedProfile(
  profileId: string | undefined,
  env: NodeJS.ProcessEnv,
): LocalBrowserProfile {
  const profile = profileId
    ? resolveLocalBrowserProfile(profileId, { env })
    : resolvePreferredLocalBrowserProfile({ env });
  if (!profile) {
    throw new ManagedBrowserError(
      "browser_profile_unavailable",
      profileId
        ? `Local browser profile not found: ${profileId}`
        : "No local browser profile is available to seed the managed hidden provider",
    );
  }
  return profile;
}

function runtimePaths(
  runtimeRoot: string,
  partitionId: string,
): {
  runtimeDir: string;
  descriptorPath: string;
  profileDir: string;
  ownerReportPath: string;
} {
  const partitionKey = createHash("sha256")
    .update(partitionId)
    .digest("hex")
    .slice(0, 24);
  const runtimeDir = join(runtimeRoot, "managed", partitionKey);
  return {
    runtimeDir,
    descriptorPath: join(runtimeDir, "runtime.json"),
    profileDir: join(runtimeDir, "profile"),
    ownerReportPath: join(runtimeDir, "process-owner.json"),
  };
}

function createEphemeralProfile(runtimeDir: string): string {
  const parent = join(runtimeDir, "ephemeral");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(parent, "profile-"));
}

async function preparePersistentProfile(
  targetUserDataDir: string,
  profile: LocalBrowserProfile,
): Promise<string> {
  await prepareSeededAutomationProfile(profile, targetUserDataDir);
  return targetUserDataDir;
}

async function recoverRuntime(
  descriptorPath: string,
  request: ManagedBrowserTargetRequest,
  brokerRuntimeId: string,
): Promise<ManagedRuntime | null> {
  const descriptor = readRuntimeDescriptor(descriptorPath);
  if (!descriptor) return null;
  assertRuntimePolicy(descriptor, request);
  if (!processOwnerExists(descriptor.process_owner)) {
    if (processIsAlive(descriptor.browser_pid)) {
      throw new ManagedBrowserError(
        "browser_runtime_identity_invalid",
        `Managed runtime owner is absent while browser process ${String(descriptor.browser_pid)} remains live; runtime evidence and profile were retained`,
      );
    }
    rmSync(descriptorPath, { force: true });
    if (descriptor.profile_source === "ephemeral") {
      rmSync(descriptor.user_data_dir, { recursive: true, force: true });
    }
    return null;
  }
  assertRuntimeOwnerProcessIdentity(descriptor);
  if (!processIsAlive(descriptor.browser_pid)) {
    await stopRuntimeProcess(descriptor);
    rmSync(descriptorPath, { force: true });
    if (descriptor.profile_source === "ephemeral") {
      rmSync(descriptor.user_data_dir, { recursive: true, force: true });
    }
    return null;
  }
  assertRuntimeBrowserProcessIdentity(descriptor);
  if (!(await cdpIsAvailable(descriptor.cdp_port))) {
    await stopRuntimeProcess(descriptor);
    rmSync(descriptorPath, { force: true });
    if (descriptor.profile_source === "ephemeral") {
      rmSync(descriptor.user_data_dir, { recursive: true, force: true });
    }
    return null;
  }
  const browserClient = await connectRecoveredBrowser(
    descriptorPath,
    descriptor,
  );
  const recoveredDescriptor = {
    ...descriptor,
    broker_runtime_id: brokerRuntimeId,
  };
  writeRuntimeDescriptor(descriptorPath, recoveredDescriptor);
  return {
    descriptor: recoveredDescriptor,
    browserClient,
    recovered: true,
    retiring: false,
    targets: new Map(),
  };
}

async function cdpIsAvailable(port: number): Promise<boolean> {
  try {
    await CDPClient.discoverBrowser(port);
    return true;
  } catch {
    return false;
  }
}

function assertRuntimeOwnerProcessIdentity(
  descriptor: RuntimeDescriptor,
): void {
  if (!runtimeOwnerProcessMatches(descriptor)) {
    throw new ManagedBrowserError(
      "browser_runtime_identity_invalid",
      `Live process owner ${String(descriptor.process_owner.owner_pid)} does not match managed runtime ${descriptor.runtime_id}`,
    );
  }
}

function assertRuntimeBrowserProcessIdentity(
  descriptor: RuntimeDescriptor,
): void {
  if (!runtimeBrowserProcessMatches(descriptor)) {
    throw new ManagedBrowserError(
      "browser_runtime_identity_invalid",
      `Live browser process ${String(descriptor.browser_pid)} does not match managed runtime ${descriptor.runtime_id}`,
    );
  }
}

async function runtimeIsLive(runtime: ManagedRuntime): Promise<boolean> {
  if (!processOwnerExists(runtime.descriptor.process_owner)) return false;
  if (!processIsAlive(runtime.descriptor.browser_pid)) return false;
  if (!runtimeOwnerProcessMatches(runtime.descriptor)) return false;
  if (!runtimeBrowserProcessMatches(runtime.descriptor)) return false;
  try {
    await runtime.browserClient.send("Browser.getVersion");
    return true;
  } catch (error) {
    if (error instanceof CDPCommandTransportError && error.target_unusable) {
      return false;
    }
    throw error;
  }
}

function runtimeOwnerProcessMatches(descriptor: RuntimeDescriptor): boolean {
  const owner = descriptor.process_owner;
  if (!processOwnerExists(owner)) return false;
  if (owner.kind === "posix-process-group") {
    return (
      owner.owner_pid === descriptor.browser_pid &&
      owner.process_group_id === descriptor.browser_pid
    );
  }
  let command: string;
  try {
    command = processCommand(owner.owner_pid);
  } catch (error) {
    if (!processOwnerExists(owner)) return false;
    throw error;
  }
  return (
    command.includes("unicli-process-owner") &&
    commandMatchesRuntime(command, descriptor)
  );
}

function runtimeBrowserProcessMatches(descriptor: RuntimeDescriptor): boolean {
  let command: string;
  try {
    command = processCommand(descriptor.browser_pid);
  } catch (error) {
    if (!processIsAlive(descriptor.browser_pid)) return false;
    throw error;
  }
  return commandMatchesRuntime(command, descriptor);
}

function commandMatchesRuntime(
  command: string,
  descriptor: RuntimeDescriptor,
): boolean {
  return (
    command.includes(descriptor.browser_path) &&
    command.includes("--headless=new") &&
    command.includes(`--user-data-dir=${descriptor.user_data_dir}`)
  );
}

function readRuntimeDescriptor(path: string): RuntimeDescriptor | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new ManagedBrowserError(
      "browser_runtime_identity_invalid",
      `Managed browser runtime descriptor is unreadable: ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (!isRuntimeDescriptor(parsed)) {
    throw new ManagedBrowserError(
      "browser_runtime_identity_invalid",
      `Managed browser runtime descriptor has an invalid schema: ${path}`,
    );
  }
  return parsed;
}

function writeRuntimeDescriptor(
  path: string,
  descriptor: RuntimeDescriptor,
): void {
  const temporaryPath = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(descriptor, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
  chmodSync(path, 0o600);
}

function removeRuntimeDescriptor(path: string, runtimeId: string): void {
  const current = readRuntimeDescriptor(path);
  if (current?.runtime_id === runtimeId) rmSync(path, { force: true });
}

function isRuntimeDescriptor(
  candidate: unknown,
): candidate is RuntimeDescriptor {
  if (typeof candidate !== "object" || candidate === null) return false;
  const value = candidate as Record<string, unknown>;
  return (
    value.version === RUNTIME_DESCRIPTOR_VERSION &&
    typeof value.runtime_id === "string" &&
    typeof value.broker_runtime_id === "string" &&
    typeof value.profile_partition_id === "string" &&
    (value.profile_source === "ephemeral" ||
      value.profile_source === "seeded") &&
    typeof value.browser_pid === "number" &&
    isProcessOwnerIdentity(value.process_owner) &&
    typeof value.cdp_port === "number" &&
    typeof value.user_data_dir === "string" &&
    typeof value.browser_path === "string" &&
    typeof value.started_at === "string"
  );
}

function isProcessOwnerIdentity(
  candidate: unknown,
): candidate is ProcessOwnerIdentity {
  if (typeof candidate !== "object" || candidate === null) return false;
  const value = candidate as Record<string, unknown>;
  if (
    value.kind === "posix-process-group" &&
    Number.isSafeInteger(value.owner_pid) &&
    (value.owner_pid as number) > 0 &&
    Number.isSafeInteger(value.process_group_id) &&
    (value.process_group_id as number) > 0
  ) {
    return value.owner_pid === value.process_group_id;
  }
  return (
    value.kind === "windows-job" &&
    Number.isSafeInteger(value.owner_pid) &&
    (value.owner_pid as number) > 0
  );
}

async function launchHeadlessBrowser(input: {
  browserPath: string;
  userDataDir: string;
  profileDirectory?: string;
  startupTimeoutMs: number;
  ownerReportPath: string;
}): Promise<{
  child: ChildProcess;
  pid: number;
  processOwner: ProcessOwnerIdentity;
  port: number;
}> {
  const activePortPath = join(input.userDataDir, "DevToolsActivePort");
  rmSync(activePortPath, { force: true });
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${input.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
  ];
  if (input.profileDirectory) {
    args.push(`--profile-directory=${input.profileDirectory}`);
  }
  args.push("about:blank");
  rmSync(input.ownerReportPath, { force: true });
  const launch = spawnOwnedProcess(input.browserPath, args, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    reportPath: input.ownerReportPath,
  });
  const child = launch.child;
  const spawnState: { error: Error | null } = { error: null };
  child.once("error", (error) => {
    spawnState.error = error;
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(
      -MAX_STARTUP_STDERR_BYTES,
    );
  });
  try {
    const commandPid = launch.commandPid;
    if (!commandPid) {
      throw new ManagedBrowserError(
        "browser_runtime_start_failed",
        "Managed Chromium launch did not expose its command process identity",
      );
    }
    const [processOwner, pid] = await Promise.all([
      launch.identity,
      commandPid,
    ]);
    const deadline = Date.now() + input.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (spawnState.error) {
        throw new ManagedBrowserError(
          "browser_runtime_start_failed",
          `Headless Chromium could not start: ${spawnState.error.message}`,
          { cause: spawnState.error },
        );
      }
      if (!processIsAlive(pid)) {
        throw new ManagedBrowserError(
          "browser_runtime_start_failed",
          `Headless Chromium exited before exposing DevTools: ${stderr.trim() || "no stderr"}`,
        );
      }
      const port = readActivePort(activePortPath);
      if (port !== null) {
        try {
          await CDPClient.discoverBrowser(port);
          return { child, pid, processOwner, port };
        } catch (error) {
          if (Date.now() + STARTUP_POLL_MS >= deadline) {
            throw new ManagedBrowserError(
              "browser_runtime_start_failed",
              `Headless Chromium wrote DevToolsActivePort ${String(port)} but CDP stayed unavailable: ${errorMessage(error)}`,
              { cause: error },
            );
          }
        }
      }
      await sleep(STARTUP_POLL_MS);
    }
    throw new ManagedBrowserError(
      "browser_runtime_start_failed",
      `Headless Chromium did not expose DevTools within ${String(input.startupTimeoutMs)}ms: ${stderr.trim() || "no stderr"}`,
    );
  } catch (error) {
    try {
      await terminateOwnedProcess(child);
    } catch (cleanupError) {
      throw new ManagedBrowserError(
        "browser_runtime_shutdown_failed",
        `Headless Chromium startup failed and its owned process tree remained live`,
        {
          cause: new AggregateError(
            [error, cleanupError],
            "Managed browser launch and process cleanup failed",
          ),
        },
      );
    }
    throw error;
  }
}

function readActivePort(path: string): number | null {
  if (!existsSync(path)) return null;
  const firstLine = readFileSync(path, "utf8").split(/\r?\n/, 1)[0];
  const port = Number.parseInt(firstLine, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ManagedBrowserError(
      "browser_runtime_identity_invalid",
      `Chromium wrote an invalid DevToolsActivePort value: ${firstLine}`,
    );
  }
  return port;
}

async function createBrowserContext(
  client: CDPClient,
  signal?: AbortSignal,
): Promise<string> {
  const response = (await sendManagedAllocationCommand(
    client,
    "Target.createBrowserContext",
    { disposeOnDetach: false },
    signal,
  )) as { browserContextId?: string };
  if (!response.browserContextId) {
    throw new ManagedBrowserError(
      "browser_runtime_start_failed",
      "Chrome did not return a browser context id for an isolated session",
    );
  }
  return response.browserContextId;
}

async function createPageTarget(
  client: CDPClient,
  browserContextId?: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = (await sendManagedAllocationCommand(
    client,
    "Target.createTarget",
    {
      url: "about:blank",
      ...(browserContextId ? { browserContextId } : {}),
    },
    signal,
  )) as { targetId?: string };
  if (!response.targetId) {
    throw new ManagedBrowserError(
      "browser_runtime_start_failed",
      "Chrome did not return a target id for the managed page",
    );
  }
  return response.targetId;
}

async function connectTargetWithRetry(
  targetId: string,
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CDPClient> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await CDPClient.connectToTarget(targetId, port, signal);
    } catch (error) {
      signal?.throwIfAborted();
      lastError = error;
      await sleep(STARTUP_POLL_MS, signal);
    }
  }
  throw new ManagedBrowserError(
    "browser_runtime_start_failed",
    `Managed Chrome target ${targetId} did not become connectable: ${errorMessage(lastError)}`,
    { cause: lastError },
  );
}

async function closeAllPageTargets(client: CDPClient): Promise<void> {
  const response = (await client.send("Target.getTargets")) as {
    targetInfos?: Array<{ targetId?: string; type?: string }>;
  };
  const pageTargetIds = (response.targetInfos ?? [])
    .filter(
      (target): target is { targetId: string; type?: string } =>
        target.type === "page" && typeof target.targetId === "string",
    )
    .map((target) => target.targetId);
  for (const targetId of pageTargetIds) {
    await closeTargetIfPresent(client, targetId);
  }
}

async function connectRecoveredBrowser(
  descriptorPath: string,
  descriptor: RuntimeDescriptor,
): Promise<CDPClient> {
  let browserClient: CDPClient | null = null;
  try {
    browserClient = await CDPClient.connectToBrowser(descriptor.cdp_port);
    await closeAllPageTargets(browserClient);
    return browserClient;
  } catch (error) {
    return rejectUnsafeRecovery(
      descriptorPath,
      descriptor,
      browserClient,
      error,
    );
  }
}

async function rejectUnsafeRecovery(
  descriptorPath: string,
  descriptor: RuntimeDescriptor,
  browserClient: CDPClient | null,
  recoveryError: unknown,
): Promise<never> {
  const cleanupErrors: unknown[] = [];
  if (browserClient) {
    try {
      await browserClient.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await stopRuntimeProcess(descriptor);
  } catch (error) {
    throw new ManagedBrowserError(
      "browser_runtime_shutdown_failed",
      `Unsafe recovered browser process ${String(descriptor.browser_pid)} remained live; runtime evidence and profile were retained`,
      {
        cause: new AggregateError(
          [recoveryError, ...cleanupErrors, error],
          "Managed browser recovery and process cleanup failed",
        ),
      },
    );
  }
  try {
    rmSync(descriptorPath, { force: true });
    if (descriptor.profile_source === "ephemeral") {
      rmSync(descriptor.user_data_dir, { recursive: true, force: true });
    }
  } catch (error) {
    cleanupErrors.push(error);
  }
  throw new ManagedBrowserError(
    "browser_runtime_start_failed",
    `Managed browser recovery could not discard targets whose broker ownership was lost: ${errorMessage(recoveryError)}`,
    {
      cause:
        cleanupErrors.length === 0
          ? recoveryError
          : new AggregateError(
              [recoveryError, ...cleanupErrors],
              "Managed browser recovery and cleanup failed",
            ),
    },
  );
}

async function closeTargetIfPresent(
  client: CDPClient,
  targetId: string,
): Promise<void> {
  if (!(await targetExists(client, targetId))) return;
  let closed: { success?: boolean };
  try {
    closed = (await client.send("Target.closeTarget", { targetId })) as {
      success?: boolean;
    };
  } catch (error) {
    try {
      if (!(await targetExists(client, targetId))) return;
    } catch (inventoryError) {
      throw new AggregateError(
        [error, inventoryError],
        `Chrome target ${targetId} close outcome and inventory are both unavailable`,
      );
    }
    throw error;
  }
  if (closed.success !== true) {
    throw new ManagedBrowserError(
      "browser_runtime_start_failed",
      `Chrome refused to close managed target ${targetId}`,
    );
  }
  const deadline = Date.now() + TARGET_CLOSE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await targetExists(client, targetId))) return;
    await sleep(50);
  }
  throw new ManagedBrowserError(
    "browser_runtime_shutdown_failed",
    `Chrome target ${targetId} remained live after close confirmation`,
  );
}

async function disposeBrowserContext(
  client: CDPClient,
  browserContextId: string,
): Promise<void> {
  if (!(await browserContextExists(client, browserContextId))) return;
  try {
    await client.send("Target.disposeBrowserContext", { browserContextId });
  } catch (error) {
    try {
      if (!(await browserContextExists(client, browserContextId))) return;
    } catch (inventoryError) {
      throw new AggregateError(
        [error, inventoryError],
        `Chrome context ${browserContextId} disposal outcome and inventory are both unavailable`,
      );
    }
    throw error;
  }
  if (await browserContextExists(client, browserContextId)) {
    throw new ManagedBrowserError(
      "browser_runtime_shutdown_failed",
      `Chrome context ${browserContextId} remained live after disposal confirmation`,
    );
  }
}

async function targetExists(
  client: CDPClient,
  targetId: string,
): Promise<boolean> {
  const targets = (await client.send("Target.getTargets")) as {
    targetInfos?: Array<{ targetId?: string }>;
  };
  return (targets.targetInfos ?? []).some(
    (target) => target.targetId === targetId,
  );
}

async function browserContextExists(
  client: CDPClient,
  browserContextId: string,
): Promise<boolean> {
  const contexts = (await client.send("Target.getBrowserContexts")) as {
    browserContextIds?: string[];
  };
  return (contexts.browserContextIds ?? []).includes(browserContextId);
}

async function requestBrowserClose(client: CDPClient): Promise<void> {
  await client.send("Browser.close");
}

function runtimeStatus(runtime: ManagedRuntime): ManagedBrowserRuntimeStatus {
  return {
    runtime_id: runtime.descriptor.runtime_id,
    provider: "managed",
    profile_partition_id: runtime.descriptor.profile_partition_id,
    profile_source: runtime.descriptor.profile_source,
    ...(runtime.descriptor.profile_id
      ? { profile_id: runtime.descriptor.profile_id }
      : {}),
    browser_pid: runtime.descriptor.browser_pid,
    process_owner: runtime.descriptor.process_owner,
    broker_pid: process.pid,
    cdp_port: runtime.descriptor.cdp_port,
    user_data_dir: runtime.descriptor.user_data_dir,
    visibility: "hidden",
    target_count: runtime.targets.size,
    recovered: runtime.recovered,
  };
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

async function waitForProcessOwnerExit(
  owner: ProcessOwnerIdentity,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processOwnerExists(owner)) await sleep(50);
}

async function stopRuntimeProcess(
  descriptor: RuntimeDescriptor,
  initialWaitMs = 0,
  child?: ChildProcess,
): Promise<void> {
  const owner = descriptor.process_owner;
  if (initialWaitMs > 0) {
    await waitForProcessOwnerExit(owner, initialWaitMs);
  }
  if (processOwnerExists(owner)) {
    if (child) await terminateOwnedProcess(child);
    else {
      assertRuntimeOwnerProcessIdentity(descriptor);
      await terminateProcessOwner(owner);
    }
  }
  if (processOwnerExists(owner) || runtimeBrowserProcessMatches(descriptor)) {
    throw new ManagedBrowserError(
      "browser_runtime_shutdown_failed",
      `Managed browser owner ${String(owner.owner_pid)} remained live after tree termination`,
    );
  }
}

function isManagedBrowserError(
  error: unknown,
  code: ManagedBrowserErrorCode,
): error is ManagedBrowserError {
  return error instanceof ManagedBrowserError && error.code === code;
}

function processCommand(pid: number): string {
  if (process.platform === "win32") return windowsProcessCommand(pid);
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    }).trim();
  } catch (error) {
    throw new ManagedBrowserError(
      "browser_runtime_identity_invalid",
      `Unable to inspect live managed browser process ${String(pid)}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function windowsProcessCommand(pid: number): string {
  try {
    return execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${String(pid)}").CommandLine`,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2_000,
      },
    ).trim();
  } catch (error) {
    throw new ManagedBrowserError(
      "browser_runtime_identity_invalid",
      `Unable to inspect live managed browser process ${String(pid)}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(
        signal?.reason ?? new Error("Managed browser operation cancelled"),
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

class ManagedAllocationOutcomeAmbiguousError extends Error {
  readonly outcome_ambiguous = true;
  readonly target_unusable = false;

  constructor(method: string, reason: unknown) {
    super(
      `Managed target allocation command '${method}' was cancelled after dispatch`,
      { cause: reason },
    );
    this.name = "ManagedAllocationOutcomeAmbiguousError";
  }
}

async function sendManagedAllocationCommand(
  client: CDPClient,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  try {
    return await client.send(method, params, undefined, signal);
  } catch (error) {
    if (signal?.aborted && error === signal.reason) {
      throw new ManagedAllocationOutcomeAmbiguousError(method, error);
    }
    throw error;
  }
}

function allocationOutcomeIsAmbiguous(error: unknown): boolean {
  return (
    (error instanceof CDPCommandTransportError && error.outcome_ambiguous) ||
    (typeof error === "object" &&
      error !== null &&
      "outcome_ambiguous" in error &&
      (error as { outcome_ambiguous?: unknown }).outcome_ambiguous === true)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function managedBrowserSuggestion(code: ManagedBrowserErrorCode): string {
  switch (code) {
    case "browser_binary_unavailable":
      return "Install Chrome for Testing/Chromium or set CHROME_PATH to an automation-capable browser binary.";
    case "browser_profile_unavailable":
      return "Open a local Chromium profile once, choose a valid --profile-id, or request an explicit ephemeral session.";
    case "browser_partition_conflict":
      return "Use a new profile partition id when changing persistence or source-profile policy.";
    case "browser_runtime_start_failed":
      return "Run `unicli browser doctor --json`; inspect the managed provider startup evidence before retrying.";
    case "browser_runtime_shutdown_failed":
      return "Inspect the managed runtime descriptor and process state, then retry broker shutdown before removing any runtime files.";
    case "browser_runtime_identity_invalid":
      return "Stop the browser broker and remove only the reported stale runtime descriptor, then restart.";
    case "browser_target_not_found":
      return "Create a new broker-owned target for the current Agent session.";
  }
}
