/**
 * @owner       src/browser/runtime-broker.ts
 * @does        Route authenticated lifecycle, native-host, target ownership, visibility, and page requests through managed and Chrome browser providers.
 * @needs       node:crypto, src/browser/chrome-provider.ts, chrome-native-protocol.ts, managed-browser.ts, remote-browser.ts, runtime-protocol.ts, runtime-session.ts
 * @feeds       src/browser/runtime-transport.ts, runtime-broker-main.ts, CLI/MCP browser clients and native host
 * @breaks      Returns structured lifecycle, ownership, visibility, provider, native-host, CDP, and command errors without provider fallback.
 * @invariants  Providers own processes/tabs; every mutation crosses an exclusive target queue; profiles have one writer; visibility never changes implicitly.
 * @side-effects Starts/stops managed runtimes, brokers extension commands, mutates lifecycle/target state, and executes page/CDP operations.
 * @perf        Status is O(sessions + targets + runtimes); commands add one local broker hop and Chrome commands add one native-host hop.
 * @concurrency Per-target FIFO is registry-owned; distinct targets run in parallel; managed launch is coalesced; one native host serializes Chrome delivery.
 * @test        tests/unit/browser-runtime-session.test.ts, tests/unit/chrome-provider.test.ts, tests/integration/browser-runtime-broker.test.ts, tests/integration/browser-extension-background.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import { randomUUID } from "node:crypto";

import { ChromeBrowserProvider } from "./chrome-provider.js";
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

export class BrowserRuntimeBroker {
  readonly runtimeId: string;
  private readonly startedAtMs: number;
  private readonly sessionTtlMs: number;
  private readonly registry: BrowserRuntimeSessionRegistry;
  private readonly managedProvider: ManagedBrowserProvider;
  private readonly chromeProvider: ChromeBrowserProvider;
  private readonly remoteProvider: RemoteBrowserProvider;
  private readonly sessionTargetIds = new Map<string, Set<string>>();
  private readonly pendingTargetReleaseOwners = new Map<string, string>();
  private readonly targetPolicies = new Map<string, TargetPolicy>();
  private readonly now: () => number;

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
  ): Promise<BrowserBrokerResponse> {
    try {
      return { id: request.id, ok: true, data: await this.execute(request) };
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
      sessions: {
        ...this.registry.status(),
        pending_release_session_ids: [
          ...new Set(this.pendingTargetReleaseOwners.values()),
        ].sort(),
        pending_release_target_ids: [
          ...this.pendingTargetReleaseOwners.keys(),
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
    const releaseErrors = await this.retryPendingSessionReleases();
    const reaped = await this.registry.reapIdleSessions(this.sessionTtlMs);
    const outcomes: BrowserSessionEndResult[] = [];
    for (const session of reaped) {
      try {
        const releasedTargets = await this.releaseSessionTargets(
          session.agent_session_id,
          session.target_leases,
        );
        outcomes.push({
          agent_session_id: session.agent_session_id,
          released_targets: releasedTargets,
        });
      } catch (error) {
        releaseErrors.push(error);
      }
    }
    throwCollectedErrors(releaseErrors, "Browser session reaping failed");
    return outcomes;
  }

  async close(): Promise<void> {
    let closeError: unknown;
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
    this.chromeProvider.close();
    this.sessionTargetIds.clear();
    this.pendingTargetReleaseOwners.clear();
    this.targetPolicies.clear();
    if (closeError) throw closeError;
  }

  private async execute(request: BrowserBrokerRequest): Promise<unknown> {
    switch (request.action) {
      case "broker.status":
        return this.status();
      case "broker.shutdown":
        return { shutting_down: true };
      case "session.start": {
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
        };
      }
      case "turn.end": {
        const released = await this.registry.endTurn(request.context);
        await this.releaseLeases(released);
        return {
          agent_session_id: request.context.agent_session_id,
          turn_id: request.context.turn_id,
          released_targets: released,
        };
      }
      case "session.end":
        return this.endSession(request.agent_session_id);
      case "target.command":
        return this.executeTargetCommand(request);
      case "target.handoff": {
        const lease = await this.registry.handoffTarget(
          request.target_id,
          request.from,
          request.to,
        );
        this.removeSessionTarget(
          request.from.agent_session_id,
          request.target_id,
        );
        this.addSessionTarget(request.to.agent_session_id, request.target_id);
        return lease;
      }
      case "chrome.tabs.list":
        this.registry.touchSession(request.context);
        return this.chromeProvider.listTabs();
      case "chrome.target.claim":
        return this.claimChromeTarget(request);
      case "chrome.target.finalize":
        return this.finalizeChromeTarget(
          request.context,
          request.target_id,
          request.disposition,
        );
      case "chrome.host.register":
        this.chromeProvider.registerHost(
          request.host_instance_id,
          request.hello,
        );
        return this.chromeProvider.status();
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
  ): Promise<BrowserTargetCommandResult> {
    const targetId = await this.resolveTarget(request);
    const data = await this.registry.runTargetMutation(
      request.context,
      targetId,
      async (signal) => {
        if (signal.aborted) throw signal.reason;
        const result =
          request.provider === "managed"
            ? await executeCdpPageCommand(
                this.managedProvider.getPage(targetId),
                request.command,
              )
            : request.provider === "remote"
              ? await executeCdpPageCommand(
                  this.remoteProvider.getPage(targetId),
                  request.command,
                )
              : await this.chromeProvider.execute(
                  targetId,
                  request.visibility,
                  request.command,
                );
        if (signal.aborted) throw signal.reason;
        return result;
      },
    );
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
        ...(data === undefined ? {} : { data }),
      };
    }
    if (request.provider === "remote") {
      return {
        target_id: targetId,
        runtime_id: this.runtimeId,
        provider: "remote",
        visibility: "hidden",
        ...(data === undefined ? {} : { data }),
      };
    }
    const chromeStatus = this.chromeProvider.status();
    return {
      target_id: targetId,
      runtime_id: chromeStatus.host_instance_id ?? this.runtimeId,
      provider: "chrome",
      visibility: request.visibility,
      ...(data === undefined ? {} : { data }),
    };
  }

  private async resolveTarget(
    request: BrowserTargetCommandRequest,
  ): Promise<string> {
    if (request.target_id) {
      this.assertTargetPolicy(request.target_id, request);
      return request.target_id;
    }
    const ownedTargetId = [
      ...(this.sessionTargetIds.get(request.context.agent_session_id) ?? []),
    ].find((targetId) => {
      const policy = this.targetPolicies.get(targetId);
      return (
        policyMatchesRequest(policy, request) &&
        (policy?.provider !== "chrome" ||
          this.chromeProvider.hasLiveTarget(targetId))
      );
    });
    if (ownedTargetId) return ownedTargetId;
    if (request.provider === "managed") {
      return this.acquireManagedTarget(request);
    }
    if (request.provider === "remote") {
      return this.acquireRemoteTarget(request);
    }
    return this.acquireChromeTarget(request);
  }

  private async acquireManagedTarget(
    request: ManagedBrowserTargetCommandRequest,
  ): Promise<string> {
    this.registry.touchSession(request.context);
    const providerRequest: ManagedBrowserTargetRequest = {
      profile_partition_id: request.profile_partition_id,
      isolated: request.isolated,
      ephemeral: request.ephemeral,
      ...(request.profile_id ? { profile_id: request.profile_id } : {}),
    };
    const target = await this.managedProvider.acquireTarget(providerRequest);
    try {
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
    this.addSessionTarget(request.context.agent_session_id, target.target_id);
    return target.target_id;
  }

  private async acquireChromeTarget(
    request: ChromeBrowserTargetCommandRequest,
  ): Promise<string> {
    this.registry.touchSession(request.context);
    const target = await this.chromeProvider.acquireTarget(request.visibility);
    return this.claimNewChromeTarget(
      request.context,
      request.profile_partition_id,
      target,
    );
  }

  private async acquireRemoteTarget(
    request: Extract<BrowserTargetCommandRequest, { provider: "remote" }>,
  ): Promise<string> {
    this.registry.touchSession(request.context);
    const targetId = await this.remoteProvider.acquireTarget();
    try {
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
    this.addSessionTarget(request.context.agent_session_id, targetId);
    return targetId;
  }

  private async claimChromeTarget(
    request: BrowserChromeTargetClaimRequest,
  ): Promise<ChromeNativeTarget> {
    this.registry.touchSession(request.context);
    const targetId = this.chromeProvider.targetIdForTab(request.tab_id);
    const existing = this.targetPolicies.get(targetId);
    if (existing) {
      if (
        existing.provider !== "chrome" ||
        existing.profilePartitionId !== request.profile_partition_id
      ) {
        throw new BrowserTargetPolicyError(
          targetId,
          "provider or profile partition mismatch",
        );
      }
      this.registry.claimTarget(request.context, {
        target_id: targetId,
        provider: "chrome",
        profile_partition_id: request.profile_partition_id,
        visibility: request.visibility,
        lifetime: "session",
      });
      if (this.chromeProvider.hasLiveTarget(targetId)) return existing.target;
      const target = await this.chromeProvider.claimTarget(
        request.tab_id,
        request.visibility,
      );
      existing.target = target;
      return target;
    }
    const target = await this.chromeProvider.claimTarget(
      request.tab_id,
      request.visibility,
    );
    try {
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
    this.addSessionTarget(context.agent_session_id, target.target_id);
    return target.target_id;
  }

  private async finalizeChromeTarget(
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
    this.removeSessionTarget(context.agent_session_id, targetId);
    return lease;
  }

  private assertTargetPolicy(
    targetId: string,
    request: BrowserTargetCommandRequest,
  ): void {
    const policy = this.targetPolicies.get(targetId);
    if (!policy || !policyMatchesRequest(policy, request)) {
      throw new BrowserTargetPolicyError(targetId, "request policy mismatch");
    }
  }

  private async endSession(
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

  private async releaseSessionTargets(
    agentSessionId: string,
    leases: BrowserTargetLease[],
  ): Promise<BrowserTargetLease[]> {
    const targetIds = new Set([
      ...leases.map((lease) => lease.target_id),
      ...(this.sessionTargetIds.get(agentSessionId) ?? []),
    ]);
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
        await this.releaseProviderTarget(targetId);
        this.targetPolicies.delete(targetId);
        this.removeSessionTarget(agentSessionId, targetId);
        this.pendingTargetReleaseOwners.delete(targetId);
      } catch (error) {
        this.pendingTargetReleaseOwners.set(targetId, agentSessionId);
        releaseErrors.push(error);
      }
    }
    throwCollectedErrors(
      releaseErrors,
      `Browser session ${agentSessionId} target release failed`,
    );
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

  private async releasePendingSessionTargets(
    agentSessionId: string,
  ): Promise<void> {
    const pending = this.sessionTargetIds.get(agentSessionId);
    if (!pending || pending.size === 0) {
      return;
    }
    await this.releaseSessionTargets(agentSessionId, []);
  }

  private async retryPendingSessionReleases(): Promise<unknown[]> {
    const errors: unknown[] = [];
    const pending = [...this.pendingTargetReleaseOwners.entries()].sort(
      ([left], [right]) => left.localeCompare(right),
    );
    for (const [targetId, agentSessionId] of pending) {
      try {
        await this.releaseTargetIds(agentSessionId, [targetId]);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  private addSessionTarget(agentSessionId: string, targetId: string): void {
    let targets = this.sessionTargetIds.get(agentSessionId);
    if (!targets) {
      targets = new Set();
      this.sessionTargetIds.set(agentSessionId, targets);
    }
    targets.add(targetId);
  }

  private removeSessionTarget(agentSessionId: string, targetId: string): void {
    const targets = this.sessionTargetIds.get(agentSessionId);
    if (!targets) return;
    targets.delete(targetId);
    if (targets.size === 0) this.sessionTargetIds.delete(agentSessionId);
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
    return true;
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

class BrowserProviderCapabilityError extends Error {
  readonly code = "browser_capability_unavailable";
  readonly retryable = false;
  readonly suggestion =
    "Select the Chrome provider for browser UI capabilities, or use a page/CDP command supported by the managed hidden provider.";

  constructor(capability: string) {
    super(`CDP page provider does not provide ${capability}`);
    this.name = "BrowserProviderCapabilityError";
  }
}

async function executeCdpPageCommand(
  page:
    | ReturnType<ManagedBrowserProvider["getPage"]>
    | ReturnType<RemoteBrowserProvider["getPage"]>,
  command: BrowserPageCommand,
): Promise<unknown> {
  switch (command.method) {
    case "navigate":
      await page.goto(command.url, { settleMs: command.settle_ms });
      return undefined;
    case "evaluate":
      return page.evaluate(command.expression);
    case "click":
      await page.click(command.selector);
      return undefined;
    case "type":
      await page.type(command.selector, command.text);
      return undefined;
    case "press":
      await page.press(command.key, command.modifiers);
      return undefined;
    case "insert_text":
      await page.insertText(command.text);
      return undefined;
    case "scroll":
      await page.scroll(command.direction);
      return undefined;
    case "cookies":
      return page.cookies();
    case "title":
      return page.title();
    case "url":
      return page.url();
    case "snapshot":
      return page.snapshot(command.options);
    case "screenshot": {
      const bytes = await page.screenshot({
        format: command.format,
        quality: command.quality,
        fullPage: command.full_page,
        clip: command.clip,
      });
      return bytes.toString("base64");
    }
    case "cdp":
      return page.sendCDP(
        command.cdp_method,
        command.params,
        command.session_id,
      );
    case "set_file_input":
      await page.setFileInput(command.selector, command.files);
      return undefined;
    case "network_capture_start":
      return page.startNetworkCapture(command.pattern);
    case "network_capture_read":
      return page.readNetworkCapture();
    case "downloads_read":
      throw new BrowserProviderCapabilityError("download history");
    case "dialog_read":
    case "dialog_respond":
      throw new BrowserProviderCapabilityError("JavaScript dialog supervision");
  }
}

function brokerError(error: unknown): {
  code: string;
  message: string;
  suggestion: string;
  retryable: boolean;
} {
  const candidate =
    typeof error === "object" && error !== null
      ? (error as {
          code?: unknown;
          message?: unknown;
          suggestion?: unknown;
          retryable?: unknown;
        })
      : {};
  return {
    code:
      typeof candidate.code === "string"
        ? candidate.code
        : "browser_runtime_error",
    message:
      typeof candidate.message === "string" ? candidate.message : String(error),
    suggestion:
      typeof candidate.suggestion === "string"
        ? candidate.suggestion
        : "Run `unicli browser doctor --json` and inspect the exact provider/runtime state.",
    retryable:
      typeof candidate.retryable === "boolean" ? candidate.retryable : false,
  };
}

function throwCollectedErrors(errors: unknown[], message: string): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
}
