/**
 * @owner       src::transport::cdp-app-launcher
 * @does        Launch an explicitly requested CDP-capable app and retain tree ownership until the caller either proves the endpoint ready or contains the launch.
 * @needs       contained-process delivery semantics and process-owner lifecycle
 * @feeds       src/transport/adapters/cdp-browser.ts
 * @breaks      Passing AbortSignal directly to child_process can emit an unhandled AbortError after spawn; releasing before CDP readiness leaves failed launches alive.
 * @invariants  Darwin open is an outcome-ambiguous external delivery; direct launches return a pending receipt; pending receipts are either released exactly once after readiness or fully contained before failure/cancellation settles.
 * @side-effects Launches apps, signals owned process trees, and may deliver macOS open requests.
 * @perf        Direct launch waits only for the OS spawn event; containment is bounded by the shared owner.
 * @concurrency Spawn/error/abort compete through one settlement claim; receipt containment is idempotent.
 * @test        tests/unit/transport/cdp-app-launcher.test.ts
 * @stability   experimental
 * @since       2026-07-16
 */

import type { ChildProcess } from "node:child_process";

import {
  OperationOutcomeAmbiguousError,
  ProcessContainmentAmbiguousError,
  runContainedProcess,
} from "./contained-process.js";
import {
  spawnOwnedProcess,
  terminateOwnedProcess,
  type OwnedProcessLaunch,
} from "./process-owner.js";

export interface CdpAppLaunchRequest {
  app: string;
  port: number;
  processName: string;
  bundleId?: string;
  displayName?: string;
  executableNames?: readonly string[];
  extraArgs?: readonly string[];
  relaunchLosesSession?: boolean;
  signal?: AbortSignal;
}

export interface CdpAppLaunchReceipt {
  release(): void;
  contain(): Promise<void>;
}

export type CdpAppLauncher = (
  request: CdpAppLaunchRequest,
) => Promise<CdpAppLaunchReceipt | void>;

export async function launchCdpApp(
  request: CdpAppLaunchRequest,
  platform: NodeJS.Platform = process.platform,
): Promise<CdpAppLaunchReceipt | undefined> {
  request.signal?.throwIfAborted();
  const debugArg = `--remote-debugging-port=${request.port}`;
  const extraArgs = [...(request.extraArgs ?? []), debugArg];
  if (platform === "darwin") {
    const args = request.bundleId
      ? ["-b", request.bundleId, "--args", ...extraArgs]
      : ["-a", request.processName, "--args", ...extraArgs];
    const result = await runContainedProcess("open", args, {
      ...(request.signal ? { signal: request.signal } : {}),
      timeoutMs: 30_000,
      cancellationDelivery: "outcome-ambiguous",
    });
    if (result.exitCode !== 0) {
      throw new Error(`open exited with code ${String(result.exitCode)}`);
    }
    return undefined;
  }

  const command = request.executableNames?.[0] ?? request.processName;
  const launch = spawnOwnedProcess(command, extraArgs, { stdio: "ignore" });
  const receipt = new OwnedCdpAppLaunchReceipt(launch.child);
  await awaitSpawn(launch, receipt, command, request.signal);
  return receipt;
}

class OwnedCdpAppLaunchReceipt implements CdpAppLaunchReceipt {
  private released = false;
  private containment: Promise<void> | undefined;

  constructor(private readonly child: ChildProcess) {}

  release(): void {
    if (this.containment) {
      throw new Error(
        "cannot release a CDP app launch after containment began",
      );
    }
    if (this.released) return;
    this.released = true;
    this.child.unref();
  }

  contain(): Promise<void> {
    if (this.released) {
      throw new Error(
        "cannot contain a CDP app launch after ownership release",
      );
    }
    this.containment ??= terminateOwnedProcess(this.child);
    return this.containment;
  }
}

function awaitSpawn(
  launch: OwnedProcessLaunch,
  receipt: CdpAppLaunchReceipt,
  command: string,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const claim = (): boolean => {
      if (settled) return false;
      settled = true;
      launch.child.off("spawn", onSpawn);
      launch.child.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      return true;
    };
    const onSpawn = (): void => {
      if (claim()) resolve();
    };
    const onError = (error: Error): void => {
      if (claim()) reject(error);
    };
    const onAbort = (): void => {
      if (!claim()) return;
      void containAbortedLaunch(
        launch,
        receipt,
        command,
        signal?.reason ?? new DOMException("App launch aborted", "AbortError"),
      ).then(resolve, reject);
    };
    launch.child.once("spawn", onSpawn);
    launch.child.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function containAbortedLaunch(
  launch: OwnedProcessLaunch,
  receipt: CdpAppLaunchReceipt,
  command: string,
  reason: unknown,
): Promise<never> {
  await launch.identity;
  const ambiguity = new OperationOutcomeAmbiguousError(command, reason);
  try {
    await receipt.contain();
  } catch (containmentError) {
    throw new ProcessContainmentAmbiguousError(
      command,
      reason,
      ambiguity,
      containmentError,
    );
  }
  throw ambiguity;
}
