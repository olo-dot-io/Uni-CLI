/**
 * @owner       src/browser/runtime-broker.ts
 * @does        Route authenticated lifecycle, native-host inventory reconciliation, target-free Chrome content search, target ownership, visibility, and page requests through managed, remote, and Chrome providers.
 * @needs       node:crypto, src/browser/chrome-provider.ts, chrome-native-protocol.ts, managed-browser.ts, remote-browser.ts, runtime-protocol.ts, runtime-session.ts
 * @feeds       src/browser/runtime-transport.ts, runtime-broker-main.ts, CLI/MCP browser clients and native host
 * @breaks      Returns structured lifecycle, ownership, visibility, provider, native-host, CDP, and command errors without provider fallback.
 * @invariants  Providers own processes/tabs; every command response derives ownership and exact Chrome tab/window identity from the broker's target policy; shutdown rejects ordinary Agent admission while preserving broker status and authenticated Chrome host cleanup traffic until every provider teardown attempt finishes; provider-wide Chrome search touches a live Agent session but allocates no target; every mutation crosses an exclusive target queue; foreground page presence is rejected before any non-Chrome/foreground acquisition; active turn heartbeats are serialized with session teardown; target claim and release generations are linearized by deterministic target id; pending cleanup cannot be reclaimed or delete a later owner; any typed ambiguous write outcome quarantines and invalidates its target without replay; Chrome cleanup is asynchronous through provider orphan reconciliation; missing Chrome tabs invalidate their lease and only implicit commands allocate one replacement; profiles have one writer; visibility never changes implicitly.
 * @side-effects Starts/stops managed runtimes, brokers extension commands, mutates lifecycle/target state, and executes page/CDP operations.
 * @perf        Status is O(sessions + targets + runtimes); commands add one local broker hop and Chrome commands add one native-host hop.
 * @concurrency Mutation FIFO is registry-owned; claim/release FIFO is broker-owned per target id; distinct targets run in parallel; cold acquisition shares provider work but isolates each waiter's cancellation, stops accepting waiters before aborting abandoned work, and aborts shared work only after every waiter leaves; acquisition, restart, shutdown, and idle reaping are linearized per session; one native host serializes Chrome delivery.
 * @test        tests/unit/browser-runtime-session.test.ts, commands/browser.test.ts, chrome-provider.test.ts, tests/integration/browser-runtime-broker.test.ts, browser-extension-background.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import { randomUUID } from "node:crypto";

import {
  ChromeBrowserProvider,
  isMissingChromeTargetError,
} from "./chrome-provider.js";
import type { ChromeNativeTarget } from "./chrome-native-protocol.js";
import type { BrowserInvocationContext } from "./invocation-context.js";
import {
  ManagedBrowserProvider,
  type ManagedBrowserTargetRequest,
} from "./managed-browser.js";
import { RemoteBrowserProvider } from "./remote-browser.js";
import {
  BROWSER_BROKER_DEFAULT_SESSION_TTL_MS,
  BROWSER_BROKER_PRODUCT,
  BROWSER_BROKER_PROTOCOL,
  BROWSER_BROKER_PROTOCOL_VERSION,
  browserPageCommandCanMutate,
  browserPageCommandRequiresForegroundChrome,
  type BrowserBrokerError,
  type BrowserBrokerRequest,
  type BrowserBrokerResponse,
  type BrowserBrokerStatus,
  type BrowserChromeTargetClaimRequest,
  type BrowserPageCommand,
  type BrowserSessionEndResult,
  type BrowserTargetCommandRequest,
  type BrowserTargetCommandResult,
  type ChromeBrowserTargetCommandRequest,
  type ManagedBrowserTargetCommandRequest,
} from "./runtime-protocol.js";
import {
  BrowserRuntimeSessionRegistry,
  type BrowserTargetLease,
} from "./runtime-session.js";

interface BrowserRuntimeBrokerOptions {
  runtimeId?: string;
  sessionTtlMs?: number;
  provider?: ManagedBrowserProvider;
  chromeProvider?: ChromeBrowserProvider;
  remoteProvider?: RemoteBrowserProvider;
  now?: () => number;
}

interface ManagedTargetPolicy {
  provider: "managed";
  profilePartitionId: string;
  isolated: boolean;
  ephemeral: boolean;
  profileId?: string;
}

interface ChromeTargetPolicy {
  provider: "chrome";
  profilePartitionId: string;
  target: ChromeNativeTarget;
}

interface RemoteTargetPolicy {
  provider: "remote";
  profilePartitionId: string;
}

type TargetPolicy =
  | ManagedTargetPolicy
  | ChromeTargetPolicy
  | RemoteTargetPolicy;

interface PendingTargetRelease {
  ownerSessionId: string;
  token: object;
}

interface SharedTargetAcquisition {
  promise: Promise<string>;
  controller: AbortController;
  waiterCount: number;
  settled: boolean;
}

export class BrowserRuntimeBroker {
  readonly runtimeId: string;
  private readonly startedAtMs: number;
  private readonly sessionTtlMs: number;
  private readonly registry: BrowserRuntimeSessionRegistry;
  private readonly managedProvider: ManagedBrowserProvider;
  private readonly chromeProvider: ChromeBrowserProvider;
  private readonly remoteProvider: RemoteBrowserProvider;
  private readonly sessionLifecycleTails = new Map<string, Promise<void>>();
  private readonly targetLifecycleTails = new Map<string, Promise<void>>();
  private readonly targetAcquisitions = new Map<
    string,
    SharedTargetAcquisition
  >();
  private readonly pendingTargetReleases = new Map<
    string,
    PendingTargetRelease
  >();
  private readonly targetPolicies = new Map<string, TargetPolicy>();
  private readonly now: () => number;
  private reaping: Promise<BrowserSessionEndResult[]> | null = null;
  private lifecycle: "running" | "shutting_down" = "running";

  constructor(options: BrowserRuntimeBrokerOptions = {}) {
    this.runtimeId = options.runtimeId ?? randomUUID();
    this.sessionTtlMs =
      options.sessionTtlMs ?? BROWSER_BROKER_DEFAULT_SESSION_TTL_MS;
    this.now = options.now ?? Date.now;
    this.startedAtMs = this.now();
    this.registry = new BrowserRuntimeSessionRegistry({ now: this.now });
    this.managedProvider =
      options.provider ??
      new ManagedBrowserProvider({ brokerRuntimeId: this.runtimeId });
    this.chromeProvider = options.chromeProvider ?? new ChromeBrowserProvider();
    this.remoteProvider = options.remoteProvider ?? new RemoteBrowserProvider();
  }

  async dispatch(
    request: BrowserBrokerRequest,
    requestSignal?: AbortSignal,
  ): Promise<BrowserBrokerResponse> {
    try {
      requestSignal?.throwIfAborted();
      if (
        this.lifecycle === "shutting_down" &&
        !requestAllowedDuringShutdown(request)
      ) {
        throw new BrowserBrokerShuttingDownError();
      }
      return {
        id: request.id,
        ok: true,
        data: await this.execute(request, requestSignal),
      };
    } catch (error) {
      return { id: request.id, ok: false, error: brokerError(error) };
    }
  }

  status(): BrowserBrokerStatus {
    return {
      ok: true,
      product: BROWSER_BROKER_PRODUCT,
      protocol: BROWSER_BROKER_PROTOCOL,
      version: BROWSER_BROKER_PROTOCOL_VERSION,
      runtime_id: this.runtimeId,
      broker_pid: process.pid,
      uptime_ms: this.now() - this.startedAtMs,
      session_ttl_ms: this.sessionTtlMs,
      lifecycle: this.lifecycle,
      sessions: {
        ...this.registry.status(),
        pending_release_session_ids: [
          ...new Set(
            [...this.pendingTargetReleases.values()].map(
              (release) => release.ownerSessionId,
            ),
          ),
        ].sort(),
        pending_release_target_ids: [
          ...this.pendingTargetReleases.keys(),
        ].sort(),
      },
      providers: {
        managed: this.managedProvider.status(),
        chrome: this.chromeProvider.status(),
        remote: this.remoteProvider.status(),
      },
    };
  }

  async reapIdleSessions(): Promise<BrowserSessionEndResult[]> {
    if (this.reaping) return this.reaping;
    const reaping = this.performIdleReaping();
    this.reaping = reaping;
    try {
      return await reaping;
    } finally {
      if (this.reaping === reaping) this.reaping = null;
    }
  }

  private async performIdleReaping(): Promise<BrowserSessionEndResult[]> {
    const releaseErrors = await this.retryPendingSessionReleases();
    const outcomes: BrowserSessionEndResult[] = [];
    for (const agentSessionId of this.registry.idleSessionIds(
      this.sessionTtlMs,
    )) {
      try {
        const outcome = await this.endSessionIfIdle(agentSessionId);
        if (outcome) outcomes.push(outcome);
      } catch (error) {
        releaseErrors.push(error);
      }
    }
    throwCollectedErrors(releaseErrors, "Browser session reaping failed");
    return outcomes;
  }

  async close(): Promise<void> {
    this.beginShutdown();
    let closeError: unknown;
    if (this.reaping) {
      try {
        await this.reaping;
      } catch (error) {
        closeError ??= error;
      }
    }
    for (const acquisition of this.targetAcquisitions.values()) {
      acquisition.controller.abort(new Error("Browser broker is closing"));
    }
    await Promise.allSettled(
      [...this.targetAcquisitions.values()].map(
        (acquisition) => acquisition.promise,
      ),
    );
    await Promise.all(this.sessionLifecycleTails.values());
    await Promise.all(this.targetLifecycleTails.values());
    const sessionIds = this.registry
      .status()
      .sessions.map((session) => session.agent_session_id);
    for (const sessionId of sessionIds) {
      try {
        await this.endSession(sessionId);
      } catch (error) {
        closeError ??= error;
      }
    }
    const pendingReleaseErrors = await this.retryPendingSessionReleases();
    closeError ??= pendingReleaseErrors[0];
    try {
      await this.managedProvider.close();
    } catch (error) {
      closeError ??= error;
    }
    try {
      await this.remoteProvider.close();
    } catch (error) {
      closeError ??= error;
    }
    try {
      await this.chromeProvider.shutdownHost();
    } catch (error) {
      closeError ??= error;
    }
    this.chromeProvider.close();
    this.sessionLifecycleTails.clear();
    this.targetLifecycleTails.clear();
    this.targetAcquisitions.clear();
    this.pendingTargetReleases.clear();
    this.targetPolicies.clear();
    if (closeError) throw closeError;
  }

  beginShutdown(): void {
    this.lifecycle = "shutting_down";
  }

  private async execute(
    request: BrowserBrokerRequest,
    requestSignal?: AbortSignal,
  ): Promise<unknown> {
    switch (request.action) {
      case "broker.status":
        return this.status();
      case "broker.shutdown":
        this.beginShutdown();
        return { shutting_down: true, lifecycle: this.lifecycle };
      case "session.start": {
        return this.runSessionLifecycle(
          request.context.agent_session_id,
          async () => {
            const isLive = this.registry
              .status()
              .sessions.some(
                (session) =>
                  session.agent_session_id === request.context.agent_session_id,
              );
            if (!isLive) {
              await this.releasePendingSessionTargets(
                request.context.agent_session_id,
              );
            }
            this.registry.startSession(request.context);
            return {
              agent_session_id: request.context.agent_session_id,
              turn_id: request.context.turn_id,
              session_ttl_ms: this.sessionTtlMs,
            };
          },
        );
      }
      case "turn.touch":
        return this.runSessionLifecycle(
          request.context.agent_session_id,
          async () => {
            this.registry.touchSession(request.context);
            return {
              agent_session_id: request.context.agent_session_id,
              turn_id: request.context.turn_id,
              session_ttl_ms: this.sessionTtlMs,
            };
          },
        );
      case "turn.end": {
        return this.runSessionLifecycle(
          request.context.agent_session_id,
          async () => {
            const released = await this.registry.endTurn(request.context);
            await this.releaseLeases(released);
            return {
              agent_session_id: request.context.agent_session_id,
              turn_id: request.context.turn_id,
              released_targets: released,
            };
          },
        );
      }
      case "session.end":
        return this.endSession(request.agent_session_id);
      case "target.command":
        return this.executeTargetCommand(request, requestSignal);
      case "target.discard":
        return this.discardTarget(request.context, request.target_id);
      case "target.handoff": {
        const lease = await this.registry.handoffTarget(
          request.target_id,
          request.from,
          request.to,
        );
        return lease;
      }
      case "chrome.tabs.list":
        this.registry.touchSession(request.context);
        return this.chromeProvider.listTabs();
      case "chrome.content.search":
        this.registry.touchSession(request.context);
        return this.chromeProvider.searchContent(request.search, requestSignal);
      case "chrome.target.claim":
        return this.runSessionLifecycle(request.context.agent_session_id, () =>
          this.claimChromeTarget(request, requestSignal),
        );
      case "chrome.target.finalize":
        return this.finalizeChromeTarget(
          request.context,
          request.target_id,
          request.disposition,
        );
      case "chrome.host.register": {
        const registration = this.chromeProvider.registerHost(
          request.host_instance_id,
          request.hello,
        );
        for (const targetId of registration.lost_target_ids) {
          await this.registry.discardTarget(targetId);
          this.targetPolicies.delete(targetId);
          this.pendingTargetReleases.delete(targetId);
        }
        return this.chromeProvider.status();
      }
      case "chrome.host.poll":
        return this.chromeProvider.poll(request.host_instance_id);
      case "chrome.host.heartbeat":
        this.chromeProvider.heartbeat(request.host_instance_id);
        return { accepted: true };
      case "chrome.host.result":
        this.chromeProvider.deliver(request.host_instance_id, request.result);
        return { accepted: true };
      case "chrome.host.disconnect":
        this.chromeProvider.disconnectHost(request.host_instance_id);
        return { disconnected: true };
    }
  }

  private async executeTargetCommand(
    request: BrowserTargetCommandRequest,
    requestSignal?: AbortSignal,
  ): Promise<BrowserTargetCommandResult> {
    if (
      browserPageCommandRequiresForegroundChrome(request.command) &&
      (request.provider !== "chrome" || request.visibility !== "foreground")
    ) {
      throw new BrowserProviderCapabilityError(
        "foreground Chrome agent presence",
        "Select the Chrome provider with explicit foreground visibility; hidden/background work never renders page presence.",
      );
    }
    let targetId = await this.resolveCommandTarget(request, requestSignal);
    let canReplaceMissingChromeTarget =
      request.provider === "chrome" && request.target_id === undefined;
    let data: unknown;
    for (;;) {
      try {
        data = await this.runTargetCommand(request, targetId, requestSignal);
        break;
      } catch (error) {
        if (
          request.provider === "chrome" &&
          isMissingChromeTargetError(error)
        ) {
          await this.discardMissingChromeTarget(targetId);
          if (canReplaceMissingChromeTarget) {
            canReplaceMissingChromeTarget = false;
            targetId = await this.resolveCommandTarget(request, requestSignal);
            continue;
          }
          throw new BrowserTargetDiscardedError(targetId, { cause: error });
        }
        await this.rethrowTargetCommandFailure(targetId, error);
      }
    }
    return this.targetCommandResult(request, targetId, data);
  }

  private async resolveCommandTarget(
    request: BrowserTargetCommandRequest,
    requestSignal?: AbortSignal,
  ): Promise<string> {
    try {
      return await this.resolveTarget(request, requestSignal);
    } catch (error) {
      if (requestSignal?.aborted) {
        throw new BrowserCommandCanceledError(
          requestSignal.reason ?? error,
          false,
        );
      }
      throw error;
    }
  }

  private async rethrowTargetCommandFailure(
    targetId: string,
    error: unknown,
  ): Promise<never> {
    if (
      error instanceof BrowserCommandCanceledError &&
      !error.targetOutcomeAmbiguous
    ) {
      throw error;
    }
    if (
      !(error instanceof BrowserCommandCanceledError) &&
      !(error instanceof BrowserCommandOutcomeAmbiguousError) &&
      !(error instanceof BrowserTargetUnusableError)
    ) {
      throw error;
    }
    let cleanupError: unknown;
    try {
      await this.invalidateFailedTarget(targetId);
    } catch (cleanupFailure) {
      cleanupError = cleanupFailure;
    }
    if (error instanceof BrowserCommandCanceledError) {
      throw cleanupError
        ? new BrowserCommandCanceledError(error, true, cleanupError)
        : error;
    }
    if (error instanceof BrowserCommandOutcomeAmbiguousError) {
      throw cleanupError
        ? new BrowserCommandOutcomeAmbiguousError(error, cleanupError)
        : error;
    }
    throw cleanupError
      ? new BrowserTargetUnusableError(error, cleanupError)
      : error;
  }

  private targetCommandResult(
    request: BrowserTargetCommandRequest,
    targetId: string,
    data: unknown,
  ): BrowserTargetCommandResult {
    if (request.provider === "managed") {
      const runtime = this.managedProvider
        .status()
        .find(
          (candidate) =>
            candidate.profile_partition_id === request.profile_partition_id,
        );
      if (!runtime) {
        throw new BrowserTargetPolicyError(
          targetId,
          "managed runtime disappeared",
        );
      }
      return {
        target_id: targetId,
        runtime_id: runtime.runtime_id,
        provider: "managed",
        browser_pid: runtime.browser_pid,
        visibility: "hidden",
        owned: true,
        ...(data === undefined ? {} : { data }),
      };
    }
    if (request.provider === "remote") {
      return {
        target_id: targetId,
        runtime_id: this.runtimeId,
        provider: "remote",
        visibility: "hidden",
        owned: true,
        ...(data === undefined ? {} : { data }),
      };
    }
    const policy = this.targetPolicies.get(targetId);
    if (policy?.provider !== "chrome") {
      throw new BrowserTargetPolicyError(
        targetId,
        "Chrome target identity record missing",
      );
    }
    const chromeStatus = this.chromeProvider.status();
    return {
      target_id: targetId,
      runtime_id: chromeStatus.host_instance_id ?? this.runtimeId,
      provider: "chrome",
      visibility: policy.target.visibility,
      owned: policy.target.owned,
      tab_id: policy.target.tab_id,
      window_id: policy.target.window_id,
      ...(data === undefined ? {} : { data }),
    };
  }

  private async runTargetCommand(
    request: BrowserTargetCommandRequest,
    targetId: string,
    requestSignal?: AbortSignal,
  ): Promise<unknown> {
    let providerDispatched = false;
    const targetOutcomeCanBeAmbiguous = browserPageCommandCanMutate(
      request.command,
    );
    try {
      return await this.registry.runTargetMutation(
        request.context,
        targetId,
        async (signal) => {
          try {
            signal.throwIfAborted();
            let result: unknown;
            if (request.provider === "managed") {
              const page = this.managedProvider.getPage(targetId);
              providerDispatched = true;
              result = await executeCdpPageCommand(
                page,
                request.command,
                signal,
              );
            } else if (request.provider === "remote") {
              const page = this.remoteProvider.getPage(targetId);
              providerDispatched = true;
              result = await executeCdpPageCommand(
                page,
                request.command,
                signal,
              );
            } else {
              providerDispatched = true;
              result = await this.chromeProvider.execute(
                targetId,
                request.visibility,
                request.command,
                signal,
              );
            }
            signal.throwIfAborted();
            return result;
          } catch (error) {
            if (signal.aborted) {
              throw new BrowserCommandCanceledError(
                signal.reason ?? error,
                providerDispatched && targetOutcomeCanBeAmbiguous,
              );
            }
            if (
              providerDispatched &&
              targetOutcomeCanBeAmbiguous &&
              errorOutcomeIsAmbiguous(error)
            ) {
              this.registry.quarantineTarget(targetId);
              throw new BrowserCommandOutcomeAmbiguousError(error);
            }
            if (
              providerTargetIsMissing(error) ||
              (providerDispatched && errorTargetIsUnusable(error))
            ) {
              this.registry.quarantineTarget(targetId);
              throw new BrowserTargetUnusableError(error);
            }
            throw error;
          }
        },
        requestSignal,
        targetOutcomeCanBeAmbiguous,
      );
    } catch (error) {
      if (
        !(error instanceof BrowserCommandCanceledError) &&
        (requestSignal?.aborted || hasErrorCode(error, "browser_turn_ended"))
      ) {
        throw new BrowserCommandCanceledError(
          requestSignal?.reason ?? error,
          providerDispatched && targetOutcomeCanBeAmbiguous,
        );
      }
      throw error;
    }
  }

  private async invalidateFailedTarget(targetId: string): Promise<void> {
    return this.runTargetLifecycle(targetId, () =>
      this.invalidateFailedTargetLocked(targetId),
    );
  }

  private async invalidateFailedTargetLocked(targetId: string): Promise<void> {
    const policy = this.targetPolicies.get(targetId);
    const lease = await this.registry.discardTarget(targetId);
    if (!lease) return;
    if (policy?.provider === "chrome") {
      this.chromeProvider.abandonTarget(targetId);
      this.targetPolicies.delete(targetId);
      this.pendingTargetReleases.delete(targetId);
      return;
    }
    await this.releaseTargetIdLocked(lease.owner_session_id, targetId);
  }

  private async discardMissingChromeTarget(targetId: string): Promise<void> {
    return this.runTargetLifecycle(targetId, () =>
      this.discardMissingChromeTargetLocked(targetId),
    );
  }

  private async discardMissingChromeTargetLocked(
    targetId: string,
  ): Promise<void> {
    this.chromeProvider.forgetTarget(targetId);
    await this.registry.discardTarget(targetId);
    this.targetPolicies.delete(targetId);
    this.pendingTargetReleases.delete(targetId);
  }

  private async discardTarget(
    context: BrowserInvocationContext,
    targetId: string,
  ): Promise<BrowserTargetLease> {
    return this.runTargetLifecycle(targetId, () =>
      this.discardTargetLocked(context, targetId),
    );
  }

  private async discardTargetLocked(
    context: BrowserInvocationContext,
    targetId: string,
  ): Promise<BrowserTargetLease> {
    if (!this.targetPolicies.has(targetId)) {
      throw new BrowserTargetDiscardedError(targetId);
    }
    const lease = await this.registry.finalizeTarget(
      context,
      targetId,
      async (signal) => {
        signal.throwIfAborted();
        await this.releaseProviderTarget(targetId);
      },
    );
    this.targetPolicies.delete(targetId);
    this.pendingTargetReleases.delete(targetId);
    return lease;
  }

  private async resolveTarget(
    request: BrowserTargetCommandRequest,
    requestSignal?: AbortSignal,
  ): Promise<string> {
    requestSignal?.throwIfAborted();
    if (request.target_id) {
      this.assertTargetPolicy(request.target_id, request);
      return request.target_id;
    }
    const ownedTargetId = [
      ...this.registry.targetIdsForContext(request.context),
    ].find((targetId) => {
      if (this.pendingTargetReleases.has(targetId)) return false;
      const policy = this.targetPolicies.get(targetId);
      return (
        policyMatchesRequest(policy, request) &&
        (policy?.provider !== "chrome" ||
          this.chromeProvider.hasLiveTarget(targetId))
      );
    });
    if (ownedTargetId) return ownedTargetId;
    const acquisitionKey = targetAcquisitionKey(request);
    let acquisition = this.targetAcquisitions.get(acquisitionKey);
    if (!acquisition) {
      const controller = new AbortController();
      const promise = this.runSessionLifecycle(
        request.context.agent_session_id,
        () => this.acquireTarget(request, controller.signal),
      );
      acquisition = {
        promise,
        controller,
        waiterCount: 0,
        settled: false,
      };
      this.targetAcquisitions.set(acquisitionKey, acquisition);
      const shared = acquisition;
      void promise.then(
        () => this.settleTargetAcquisition(acquisitionKey, shared),
        () => this.settleTargetAcquisition(acquisitionKey, shared),
      );
    }
    return this.waitForTargetAcquisition(
      acquisitionKey,
      acquisition,
      requestSignal,
    );
  }

  private settleTargetAcquisition(
    key: string,
    acquisition: SharedTargetAcquisition,
  ): void {
    acquisition.settled = true;
    if (this.targetAcquisitions.get(key) === acquisition) {
      this.targetAcquisitions.delete(key);
    }
  }

  private async waitForTargetAcquisition(
    key: string,
    acquisition: SharedTargetAcquisition,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    acquisition.waiterCount += 1;
    let abort: (() => void) | undefined;
    try {
      if (!signal) return await acquisition.promise;
      return await new Promise<string>((resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        acquisition.promise.then(resolve, reject);
      });
    } finally {
      if (signal && abort) signal.removeEventListener("abort", abort);
      acquisition.waiterCount -= 1;
      if (acquisition.waiterCount === 0 && !acquisition.settled) {
        if (this.targetAcquisitions.get(key) === acquisition) {
          this.targetAcquisitions.delete(key);
        }
        acquisition.controller.abort(
          new Error("All target acquisition waiters canceled"),
        );
      }
    }
  }

  private acquireTarget(
    request: BrowserTargetCommandRequest,
    requestSignal?: AbortSignal,
  ): Promise<string> {
    if (request.provider === "managed") {
      return this.acquireManagedTarget(request, requestSignal);
    }
    if (request.provider === "remote") {
      return this.acquireRemoteTarget(request, requestSignal);
    }
    return this.acquireChromeTarget(request, requestSignal);
  }

  private async acquireManagedTarget(
    request: ManagedBrowserTargetCommandRequest,
    requestSignal?: AbortSignal,
  ): Promise<string> {
    this.registry.touchSession(request.context);
    const providerRequest: ManagedBrowserTargetRequest = {
      profile_partition_id: request.profile_partition_id,
      isolated: request.isolated,
      ephemeral: request.ephemeral,
      ...(request.profile_id ? { profile_id: request.profile_id } : {}),
    };
    const targetAcquisition = this.managedProvider.acquireTarget(
      providerRequest,
      requestSignal,
    );
    const target = await waitForProviderAcquisition(
      targetAcquisition,
      requestSignal,
      (lateTarget) => this.managedProvider.releaseTarget(lateTarget.target_id),
      "managed",
    );
    try {
      requestSignal?.throwIfAborted();
      this.registry.claimTarget(request.context, {
        target_id: target.target_id,
        provider: "managed",
        profile_partition_id: request.profile_partition_id,
        visibility: "hidden",
        lifetime: request.isolated ? "turn" : "session",
      });
    } catch (error) {
      await this.managedProvider.releaseTarget(target.target_id);
      throw error;
    }
    this.targetPolicies.set(target.target_id, {
      provider: "managed",
      profilePartitionId: request.profile_partition_id,
      isolated: request.isolated,
      ephemeral: request.ephemeral,
      ...(request.profile_id ? { profileId: request.profile_id } : {}),
    });
    return target.target_id;
  }

  private async acquireChromeTarget(
    request: ChromeBrowserTargetCommandRequest,
    requestSignal?: AbortSignal,
  ): Promise<string> {
    this.registry.touchSession(request.context);
    const target = await this.chromeProvider.acquireTarget(
      request.visibility,
      requestSignal,
    );
    return this.runTargetLifecycle(target.target_id, async () => {
      this.assertTargetClaimable(target.target_id);
      try {
        requestSignal?.throwIfAborted();
        return this.claimNewChromeTarget(
          request.context,
          request.profile_partition_id,
          target,
        );
      } catch (error) {
        await this.chromeProvider.releaseTarget(target.target_id);
        throw error;
      }
    });
  }

  private async acquireRemoteTarget(
    request: Extract<BrowserTargetCommandRequest, { provider: "remote" }>,
    requestSignal?: AbortSignal,
  ): Promise<string> {
    this.registry.touchSession(request.context);
    const targetAcquisition = this.remoteProvider.acquireTarget(requestSignal);
    const targetId = await waitForProviderAcquisition(
      targetAcquisition,
      requestSignal,
      (lateTargetId) => this.remoteProvider.releaseTarget(lateTargetId),
      "remote",
    );
    try {
      requestSignal?.throwIfAborted();
      this.registry.claimTarget(request.context, {
        target_id: targetId,
        provider: "remote",
        profile_partition_id: request.profile_partition_id,
        visibility: "hidden",
        lifetime: "session",
      });
    } catch (error) {
      await this.remoteProvider.releaseTarget(targetId);
      throw error;
    }
    this.targetPolicies.set(targetId, {
      provider: "remote",
      profilePartitionId: request.profile_partition_id,
    });
    return targetId;
  }

  private async claimChromeTarget(
    request: BrowserChromeTargetClaimRequest,
    requestSignal?: AbortSignal,
  ): Promise<ChromeNativeTarget> {
    const targetId = await this.chromeProvider.targetIdForTab(
      request.tab_id,
      requestSignal,
    );
    return this.runTargetLifecycle(targetId, () =>
      this.claimChromeTargetLocked(request, targetId, requestSignal),
    );
  }

  private async claimChromeTargetLocked(
    request: BrowserChromeTargetClaimRequest,
    targetId: string,
    requestSignal?: AbortSignal,
  ): Promise<ChromeNativeTarget> {
    this.registry.touchSession(request.context);
    this.assertTargetClaimable(targetId);
    const existing = this.targetPolicies.get(targetId);
    if (existing) {
      if (
        existing.provider !== "chrome" ||
        existing.profilePartitionId !== request.profile_partition_id ||
        existing.target.visibility !== request.visibility
      ) {
        throw new BrowserTargetPolicyError(
          targetId,
          "provider or profile partition mismatch",
        );
      }
      if (this.chromeProvider.hasLiveTarget(targetId)) {
        requestSignal?.throwIfAborted();
        this.registry.claimTarget(request.context, {
          target_id: targetId,
          provider: "chrome",
          profile_partition_id: request.profile_partition_id,
          visibility: request.visibility,
          lifetime: "session",
        });
        return existing.target;
      }
      const target = await this.chromeProvider.claimTarget(
        request.tab_id,
        request.visibility,
        requestSignal,
      );
      try {
        requestSignal?.throwIfAborted();
        this.registry.claimTarget(request.context, {
          target_id: targetId,
          provider: "chrome",
          profile_partition_id: request.profile_partition_id,
          visibility: request.visibility,
          lifetime: "session",
        });
        existing.target = target;
        return target;
      } catch (error) {
        await this.chromeProvider.releaseTarget(target.target_id, "release");
        throw error;
      }
    }
    const target = await this.chromeProvider.claimTarget(
      request.tab_id,
      request.visibility,
      requestSignal,
    );
    try {
      requestSignal?.throwIfAborted();
      this.claimNewChromeTarget(
        request.context,
        request.profile_partition_id,
        target,
      );
      return target;
    } catch (error) {
      await this.chromeProvider.releaseTarget(target.target_id, "release");
      throw error;
    }
  }

  private claimNewChromeTarget(
    context: BrowserInvocationContext,
    profilePartitionId: string,
    target: ChromeNativeTarget,
  ): string {
    this.registry.claimTarget(context, {
      target_id: target.target_id,
      provider: "chrome",
      profile_partition_id: profilePartitionId,
      visibility: target.visibility,
      lifetime: "session",
    });
    this.targetPolicies.set(target.target_id, {
      provider: "chrome",
      profilePartitionId,
      target,
    });
    return target.target_id;
  }

  private async finalizeChromeTarget(
    context: BrowserChromeTargetClaimRequest["context"],
    targetId: string,
    disposition?: "close" | "release",
  ): Promise<BrowserTargetLease> {
    return this.runTargetLifecycle(targetId, () =>
      this.finalizeChromeTargetLocked(context, targetId, disposition),
    );
  }

  private async finalizeChromeTargetLocked(
    context: BrowserChromeTargetClaimRequest["context"],
    targetId: string,
    disposition?: "close" | "release",
  ): Promise<BrowserTargetLease> {
    const policy = this.targetPolicies.get(targetId);
    if (policy?.provider !== "chrome") {
      throw new BrowserTargetPolicyError(targetId, "not a Chrome target");
    }
    const lease = await this.registry.finalizeTarget(
      context,
      targetId,
      async (signal) => {
        if (signal.aborted) throw signal.reason;
        await this.chromeProvider.releaseTarget(targetId, disposition);
      },
    );
    this.targetPolicies.delete(targetId);
    return lease;
  }

  private assertTargetPolicy(
    targetId: string,
    request: BrowserTargetCommandRequest,
  ): void {
    const policy = this.targetPolicies.get(targetId);
    if (!policy) {
      throw new BrowserTargetDiscardedError(targetId);
    }
    if (!policyMatchesRequest(policy, request)) {
      throw new BrowserTargetPolicyError(targetId, "request policy mismatch");
    }
  }

  private async endSession(
    agentSessionId: string,
  ): Promise<BrowserSessionEndResult> {
    return this.runSessionLifecycle(agentSessionId, () =>
      this.performSessionEnd(agentSessionId),
    );
  }

  private async performSessionEnd(
    agentSessionId: string,
  ): Promise<BrowserSessionEndResult> {
    const releasedLeases = await this.registry.endSession(agentSessionId);
    const releasedTargets = await this.releaseSessionTargets(
      agentSessionId,
      releasedLeases,
    );
    return {
      agent_session_id: agentSessionId,
      released_targets: releasedTargets,
    };
  }

  private endSessionIfIdle(
    agentSessionId: string,
  ): Promise<BrowserSessionEndResult | null> {
    return this.runSessionLifecycle(agentSessionId, async () => {
      if (!this.registry.isSessionIdle(agentSessionId, this.sessionTtlMs)) {
        return null;
      }
      return this.performSessionEnd(agentSessionId);
    });
  }

  private async releaseSessionTargets(
    agentSessionId: string,
    leases: BrowserTargetLease[],
  ): Promise<BrowserTargetLease[]> {
    const targetIds = new Set(leases.map((lease) => lease.target_id));
    await this.releaseTargetIds(agentSessionId, targetIds);
    return leases;
  }

  private async releaseTargetIds(
    agentSessionId: string,
    targetIds: Iterable<string>,
  ): Promise<void> {
    const releaseErrors: unknown[] = [];
    for (const targetId of targetIds) {
      try {
        await this.runTargetLifecycle(targetId, () =>
          this.releaseTargetIdLocked(agentSessionId, targetId),
        );
      } catch (error) {
        releaseErrors.push(error);
      }
    }
    throwCollectedErrors(
      releaseErrors,
      `Browser session ${agentSessionId} target release failed`,
    );
  }

  private async releaseTargetIdLocked(
    agentSessionId: string,
    targetId: string,
  ): Promise<void> {
    const currentLease = this.registry.targetLease(targetId);
    const existingRelease = this.pendingTargetReleases.get(targetId);
    if (currentLease) {
      if (existingRelease?.ownerSessionId === agentSessionId) {
        this.pendingTargetReleases.delete(targetId);
      }
      return;
    }
    if (existingRelease && existingRelease.ownerSessionId !== agentSessionId) {
      throw new BrowserTargetReleasePendingError(
        targetId,
        existingRelease.ownerSessionId,
      );
    }
    const release = existingRelease ?? {
      ownerSessionId: agentSessionId,
      token: {},
    };
    this.pendingTargetReleases.set(targetId, release);
    await this.releaseProviderTarget(targetId);
    if (this.pendingTargetReleases.get(targetId)?.token !== release.token) {
      return;
    }
    this.targetPolicies.delete(targetId);
    this.pendingTargetReleases.delete(targetId);
  }

  private async releaseLeases(leases: BrowserTargetLease[]): Promise<void> {
    const releaseErrors: unknown[] = [];
    for (const lease of leases) {
      try {
        await this.releaseTargetIds(lease.owner_session_id, [lease.target_id]);
      } catch (error) {
        releaseErrors.push(error);
      }
    }
    throwCollectedErrors(releaseErrors, "Browser turn target release failed");
  }

  private async releaseProviderTarget(targetId: string): Promise<void> {
    const policy = this.targetPolicies.get(targetId);
    if (!policy) {
      throw new BrowserTargetPolicyError(targetId, "provider record missing");
    }
    if (policy.provider === "managed") {
      await this.managedProvider.releaseTarget(targetId);
      return;
    }
    if (policy.provider === "remote") {
      await this.remoteProvider.releaseTarget(targetId);
      return;
    }
    await this.chromeProvider.releaseTarget(targetId);
  }

  private assertTargetClaimable(targetId: string): void {
    const release = this.pendingTargetReleases.get(targetId);
    if (release) {
      throw new BrowserTargetReleasePendingError(
        targetId,
        release.ownerSessionId,
      );
    }
  }

  private async releasePendingSessionTargets(
    agentSessionId: string,
  ): Promise<void> {
    const targetIds = [...this.pendingTargetReleases.entries()]
      .filter(([, release]) => release.ownerSessionId === agentSessionId)
      .map(([targetId]) => targetId)
      .sort();
    await this.releaseTargetIds(agentSessionId, targetIds);
  }

  private async retryPendingSessionReleases(): Promise<unknown[]> {
    const errors: unknown[] = [];
    const pending = [...this.pendingTargetReleases.entries()].sort(
      ([left], [right]) => left.localeCompare(right),
    );
    for (const [targetId, release] of pending) {
      try {
        await this.runSessionLifecycle(release.ownerSessionId, () =>
          this.releaseTargetIds(release.ownerSessionId, [targetId]),
        );
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  private async runSessionLifecycle<T>(
    agentSessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const predecessor = this.sessionLifecycleTails.get(agentSessionId);
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.sessionLifecycleTails.set(agentSessionId, tail);
    if (predecessor) await predecessor;
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionLifecycleTails.get(agentSessionId) === tail) {
        this.sessionLifecycleTails.delete(agentSessionId);
      }
    }
  }

  private async runTargetLifecycle<T>(
    targetId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const predecessor = this.targetLifecycleTails.get(targetId);
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.targetLifecycleTails.set(targetId, tail);
    if (predecessor) await predecessor;
    try {
      return await operation();
    } finally {
      release();
      if (this.targetLifecycleTails.get(targetId) === tail) {
        this.targetLifecycleTails.delete(targetId);
      }
    }
  }
}

function policyMatchesRequest(
  policy: TargetPolicy | undefined,
  request: BrowserTargetCommandRequest,
): boolean {
  if (
    !policy ||
    policy.provider !== request.provider ||
    policy.profilePartitionId !== request.profile_partition_id
  ) {
    return false;
  }
  if (policy.provider === "chrome" && request.provider === "chrome") {
    return policy.target.visibility === request.visibility;
  }
  if (policy.provider === "remote" && request.provider === "remote") {
    return true;
  }
  return (
    policy.provider === "managed" &&
    request.provider === "managed" &&
    policy.isolated === request.isolated &&
    policy.ephemeral === request.ephemeral &&
    policy.profileId === request.profile_id
  );
}

function targetAcquisitionKey(request: BrowserTargetCommandRequest): string {
  if (request.provider === "managed") {
    return JSON.stringify([
      request.context.agent_session_id,
      request.isolated ? request.context.turn_id : null,
      request.provider,
      request.visibility,
      request.profile_partition_id,
      request.isolated,
      request.ephemeral,
      request.profile_id ?? null,
    ]);
  }
  return JSON.stringify([
    request.context.agent_session_id,
    request.provider,
    request.visibility,
    request.profile_partition_id,
  ]);
}

class BrowserTargetPolicyError extends Error {
  readonly code = "browser_target_policy_mismatch";
  readonly retryable = false;
  readonly suggestion =
    "Create or claim a target whose provider, profile partition, isolation, and persistence match the request.";

  constructor(targetId: string, reason: string) {
    super(`Browser target ${targetId} policy mismatch: ${reason}`);
    this.name = "BrowserTargetPolicyError";
  }
}

class BrowserTargetReleasePendingError extends Error {
  readonly code = "browser_target_release_pending";
  readonly retryable = true;
  readonly suggestion =
    "Retry after the previous target owner has finished provider cleanup; do not reuse the target id while release is pending.";

  constructor(targetId: string, ownerSessionId: string) {
    super(
      `Browser target ${targetId} is still releasing from session ${ownerSessionId}`,
    );
    this.name = "BrowserTargetReleasePendingError";
  }
}

class BrowserTargetDiscardedError extends Error {
  readonly code = "browser_target_discarded";
  readonly retryable = true;
  readonly suggestion =
    "Retry the command without the discarded target id so Uni-CLI can acquire a fresh target; the failed command was not replayed.";

  constructor(targetId: string, options?: ErrorOptions) {
    super(`Browser target ${targetId} is no longer available`, options);
    this.name = "BrowserTargetDiscardedError";
  }
}

class BrowserProviderCapabilityError extends Error {
  readonly code = "browser_capability_unavailable";
  readonly retryable = false;
  readonly suggestion: string;

  constructor(capability: string, suggestion?: string) {
    super(
      `Selected browser provider/visibility does not provide ${capability}`,
    );
    this.name = "BrowserProviderCapabilityError";
    this.suggestion =
      suggestion ??
      "Select the Chrome provider for browser UI capabilities, or use a page/CDP command supported by the managed hidden provider.";
  }
}

class BrowserCommandCanceledError extends Error {
  readonly code = "browser_command_canceled";
  readonly retryable: boolean;
  readonly suggestion: string;
  readonly outcome_ambiguous?: true;
  readonly target_unusable?: true;

  constructor(
    reason: unknown,
    readonly targetOutcomeAmbiguous: boolean,
    cleanupError?: unknown,
  ) {
    super(
      cleanupError
        ? `Browser command was canceled and target cleanup is pending: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        : targetOutcomeAmbiguous
          ? "Browser command was canceled after dispatch and its target was invalidated"
          : "Browser command was canceled before a mutating effect was dispatched",
      {
        cause: cleanupError
          ? new AggregateError(
              [reason, cleanupError],
              "Browser cancellation and target cleanup failed",
            )
          : reason,
      },
    );
    this.name = "BrowserCommandCanceledError";
    this.retryable = !targetOutcomeAmbiguous;
    if (targetOutcomeAmbiguous) {
      this.outcome_ambiguous = true;
      this.target_unusable = true;
    }
    this.suggestion = targetOutcomeAmbiguous
      ? "Inspect the page state before issuing another mutation; Uni-CLI invalidated the target because an already-dispatched command can have an ambiguous outcome."
      : "Retry the command if it is still needed; Uni-CLI preserved the target because no ambiguous mutating effect was dispatched.";
  }
}

class BrowserCommandOutcomeAmbiguousError extends Error {
  readonly code = "browser_command_outcome_ambiguous";
  readonly retryable = false;
  readonly outcome_ambiguous = true;
  readonly target_unusable = true;
  readonly suggestion =
    "Inspect the external effect before deciding whether to repeat it; continue only on a fresh target because the prior target lease was invalidated.";

  constructor(reason: unknown, cleanupError?: unknown) {
    super(
      cleanupError
        ? `Browser command outcome is ambiguous and target cleanup is pending: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        : "Browser command outcome is ambiguous after provider dispatch; the target lease was invalidated without replay",
      {
        cause: cleanupError
          ? new AggregateError(
              [reason, cleanupError],
              "Ambiguous browser command and target cleanup both failed",
            )
          : reason,
      },
    );
    this.name = "BrowserCommandOutcomeAmbiguousError";
  }
}

class BrowserBrokerShuttingDownError extends Error {
  readonly code = "browser_broker_shutting_down";
  readonly retryable = true;
  readonly suggestion =
    "Wait for `unicli browser broker status` to report stopped, then retry on the replacement broker.";

  constructor() {
    super(
      "Browser broker is shutting down and no longer accepts new Agent work",
    );
    this.name = "BrowserBrokerShuttingDownError";
  }
}

class BrowserTargetUnusableError extends Error {
  readonly code = "browser_target_unusable";
  readonly retryable = true;
  readonly target_unusable = true;
  readonly suggestion =
    "Retry without the unusable target id so Uni-CLI can acquire a fresh target; the failed command was not replayed.";

  constructor(reason: unknown, cleanupError?: unknown) {
    super(
      cleanupError
        ? `Browser target became unusable and cleanup is pending: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        : "Browser target transport became unusable; its lease was invalidated without replay",
      {
        cause: cleanupError
          ? new AggregateError(
              [reason, cleanupError],
              "Unusable browser target and cleanup both failed",
            )
          : reason,
      },
    );
    this.name = "BrowserTargetUnusableError";
  }
}

async function executeCdpPageCommand(
  page:
    | ReturnType<ManagedBrowserProvider["getPage"]>
    | ReturnType<RemoteBrowserProvider["getPage"]>,
  command: BrowserPageCommand,
  signal: AbortSignal,
): Promise<unknown> {
  switch (command.method) {
    case "navigate":
      await page.goto(command.url, { settleMs: command.settle_ms }, signal);
      return undefined;
    case "evaluate":
      return page.evaluate(command.expression, signal);
    case "click":
      await page.click(command.selector, signal, command.snapshot_id);
      return undefined;
    case "native_click":
      await page.nativeClick(command.x, command.y, signal);
      return undefined;
    case "type":
      await page.type(
        command.selector,
        command.text,
        signal,
        command.mode ?? "insert_text",
        command.snapshot_id,
      );
      return undefined;
    case "press":
      await page.press(command.key, command.modifiers, signal);
      return undefined;
    case "insert_text":
      await page.insertText(command.text, signal);
      return undefined;
    case "scroll":
      await page.scroll(command.direction, signal);
      return undefined;
    case "cookies":
      return page.cookies(signal);
    case "title":
      return page.title(signal);
    case "url":
      return page.url(signal);
    case "snapshot":
      return page.snapshot(command.options, signal);
    case "screenshot": {
      const bytes = await page.screenshot(
        {
          format: command.format,
          quality: command.quality,
          fullPage: command.full_page,
          clip: command.clip,
        },
        signal,
      );
      return bytes.toString("base64");
    }
    case "cdp":
      return page.sendCDP(
        command.cdp_method,
        command.params,
        command.session_id,
        signal,
      );
    case "set_file_input":
      await page.setFileInput(command.selector, command.files, signal);
      return undefined;
    case "network_capture_start":
      return page.startNetworkCapture(command.pattern, signal);
    case "network_capture_read":
      return page.readNetworkCapture(signal);
    case "downloads_read":
      throw new BrowserProviderCapabilityError("download history");
    case "dialog_read":
    case "dialog_respond":
      throw new BrowserProviderCapabilityError("JavaScript dialog supervision");
  }
}

function requestAllowedDuringShutdown(request: BrowserBrokerRequest): boolean {
  return (
    request.action === "broker.status" ||
    request.action === "broker.shutdown" ||
    request.action === "chrome.host.register" ||
    request.action === "chrome.host.poll" ||
    request.action === "chrome.host.heartbeat" ||
    request.action === "chrome.host.result" ||
    request.action === "chrome.host.disconnect"
  );
}

async function waitForProviderAcquisition<T>(
  acquisition: Promise<T>,
  signal: AbortSignal | undefined,
  releaseLateArtifact: (artifact: T) => Promise<void>,
  provider: "managed" | "remote",
): Promise<T> {
  if (!signal) return acquisition;
  signal.throwIfAborted();
  let rejectCancellation!: (reason: unknown) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const abort = (): void => rejectCancellation(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await Promise.race([acquisition, cancellation]);
  } catch (error) {
    if (signal.aborted) {
      void acquisition
        .then(releaseLateArtifact, () => undefined)
        .catch((cleanupError: unknown) => {
          process.stderr.write(
            `${JSON.stringify({
              ok: false,
              error: {
                code: "browser_late_acquisition_cleanup_failed",
                message: `${provider} target completed after cancellation and cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
                suggestion:
                  "Run `unicli browser doctor --json` and restart the broker before reusing this provider.",
                retryable: false,
              },
            })}\n`,
          );
        });
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function brokerError(error: unknown): BrowserBrokerError {
  const code = errorProperty(error, "code");
  const message = errorProperty(error, "message");
  const suggestion = errorProperty(error, "suggestion");
  const retryable = errorProperty(error, "retryable");
  const outcomeAmbiguous = errorProperty(error, "outcome_ambiguous");
  const targetUnusable = errorProperty(error, "target_unusable");
  const resolvedCode =
    typeof code === "string" ? code : "browser_runtime_error";
  const resolvedRetryable = typeof retryable === "boolean" ? retryable : false;
  const isAmbiguous =
    outcomeAmbiguous === true ||
    resolvedCode === "browser_command_outcome_ambiguous" ||
    (resolvedCode === "browser_command_canceled" && !resolvedRetryable);
  return {
    code: resolvedCode,
    message: typeof message === "string" ? message : String(error),
    suggestion:
      typeof suggestion === "string"
        ? suggestion
        : "Run `unicli browser doctor --json` and inspect the exact provider/runtime state.",
    retryable: resolvedRetryable,
    ...(isAmbiguous ? { outcome_ambiguous: true as const } : {}),
    ...(isAmbiguous || targetUnusable === true
      ? { target_unusable: true as const }
      : {}),
  };
}

function errorProperty(
  error: unknown,
  property: string,
  visited: Set<object> = new Set<object>(),
): unknown {
  if (typeof error !== "object" || error === null || visited.has(error)) {
    return undefined;
  }
  visited.add(error);
  if (property in error) {
    const value = (error as Record<string, unknown>)[property];
    if (value !== undefined) return value;
  }
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const value = errorProperty(nested, property, visited);
      if (value !== undefined) return value;
    }
  }
  return error instanceof Error
    ? errorProperty(error.cause, property, visited)
    : undefined;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function errorOutcomeIsAmbiguous(error: unknown): boolean {
  return errorFlagIsTrue(error, "outcome_ambiguous", new Set());
}

function errorTargetIsUnusable(error: unknown): boolean {
  return errorFlagIsTrue(error, "target_unusable", new Set());
}

function providerTargetIsMissing(error: unknown): boolean {
  return (
    hasErrorCode(error, "browser_target_not_found") ||
    hasErrorCode(error, "remote_browser_target_not_found")
  );
}

function errorFlagIsTrue(
  error: unknown,
  flag: "outcome_ambiguous" | "target_unusable",
  seen: Set<object>,
): boolean {
  if (typeof error !== "object" || error === null || seen.has(error)) {
    return false;
  }
  seen.add(error);
  const candidate = error as Record<string, unknown> & { cause?: unknown };
  if (candidate[flag] === true) return true;
  if (
    error instanceof AggregateError &&
    error.errors.some((entry) => errorFlagIsTrue(entry, flag, seen))
  ) {
    return true;
  }
  return errorFlagIsTrue(candidate.cause, flag, seen);
}

function throwCollectedErrors(errors: unknown[], message: string): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
}
