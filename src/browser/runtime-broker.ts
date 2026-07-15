/**
 * @owner       src/browser/runtime-broker.ts
 * @does        Route authenticated lifecycle and page requests through broker-owned sessions, target leases, visibility policy, and browser providers.
 * @needs       node:crypto, src/browser/managed-browser.ts, runtime-protocol.ts, runtime-session.ts
 * @feeds       src/browser/runtime-transport.ts, src/browser/runtime-broker-main.ts
 * @breaks      Returns structured BrowserBrokerError responses for lifecycle, ownership, visibility, provider, CDP, and command failures.
 * @invariants  Browser processes and targets are provider-owned; every mutation crosses a target lease queue; hidden requests never route to a visible provider.
 * @side-effects Starts/stops managed runtimes, mutates lifecycle/target state, and executes page/CDP operations.
 * @perf        Status is O(sessions + targets + runtimes); page commands add one local broker hop over direct CDP.
 * @concurrency Per-target FIFO comes from BrowserRuntimeSessionRegistry; distinct targets execute in parallel; per-partition launch is coalesced by ManagedBrowserProvider.
 * @test        tests/unit/browser-runtime-session.test.ts, tests/integration/browser-runtime-broker.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import { randomUUID } from "node:crypto";

import {
  ManagedBrowserProvider,
  type ManagedBrowserTargetRequest,
} from "./managed-browser.js";
import {
  BROWSER_BROKER_DEFAULT_SESSION_TTL_MS,
  BROWSER_BROKER_PRODUCT,
  BROWSER_BROKER_PROTOCOL,
  BROWSER_BROKER_PROTOCOL_VERSION,
  type BrowserBrokerRequest,
  type BrowserBrokerResponse,
  type BrowserBrokerStatus,
  type BrowserPageCommand,
  type BrowserSessionEndResult,
  type BrowserTargetCommandRequest,
  type BrowserTargetCommandResult,
} from "./runtime-protocol.js";
import {
  BrowserRuntimeSessionRegistry,
  type BrowserTargetLease,
} from "./runtime-session.js";

interface BrowserRuntimeBrokerOptions {
  runtimeId?: string;
  sessionTtlMs?: number;
  provider?: ManagedBrowserProvider;
  now?: () => number;
}

interface TargetPolicy {
  profilePartitionId: string;
  isolated: boolean;
  ephemeral: boolean;
  profileId?: string;
}

export class BrowserRuntimeBroker {
  readonly runtimeId: string;
  private readonly startedAtMs: number;
  private readonly sessionTtlMs: number;
  private readonly registry: BrowserRuntimeSessionRegistry;
  private readonly provider: ManagedBrowserProvider;
  private readonly sessionTargetIds = new Map<string, Set<string>>();
  private readonly targetPolicies = new Map<string, TargetPolicy>();
  private readonly now: () => number;

  constructor(options: BrowserRuntimeBrokerOptions = {}) {
    this.runtimeId = options.runtimeId ?? randomUUID();
    this.sessionTtlMs =
      options.sessionTtlMs ?? BROWSER_BROKER_DEFAULT_SESSION_TTL_MS;
    this.now = options.now ?? Date.now;
    this.startedAtMs = this.now();
    this.registry = new BrowserRuntimeSessionRegistry({ now: this.now });
    this.provider =
      options.provider ??
      new ManagedBrowserProvider({ brokerRuntimeId: this.runtimeId });
  }

  async dispatch(
    request: BrowserBrokerRequest,
  ): Promise<BrowserBrokerResponse> {
    try {
      return { id: request.id, ok: true, data: await this.execute(request) };
    } catch (error) {
      return {
        id: request.id,
        ok: false,
        error: brokerError(error),
      };
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
      sessions: this.registry.status(),
      providers: {
        managed: this.provider.status(),
        chrome_connected: false,
      },
    };
  }

  async reapIdleSessions(): Promise<BrowserSessionEndResult[]> {
    const reaped = await this.registry.reapIdleSessions(this.sessionTtlMs);
    const outcomes: BrowserSessionEndResult[] = [];
    for (const session of reaped) {
      const releasedTargets = await this.releaseSessionTargets(
        session.agent_session_id,
        session.target_leases,
      );
      outcomes.push({
        agent_session_id: session.agent_session_id,
        released_targets: releasedTargets,
      });
    }
    return outcomes;
  }

  async close(): Promise<void> {
    const sessionIds = this.registry
      .status()
      .sessions.map((session) => session.agent_session_id);
    for (const sessionId of sessionIds) await this.endSession(sessionId);
    await this.provider.close();
    this.sessionTargetIds.clear();
    this.targetPolicies.clear();
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
    }
  }

  private async executeTargetCommand(
    request: BrowserTargetCommandRequest,
  ): Promise<BrowserTargetCommandResult> {
    if (request.visibility !== "hidden") {
      throw new BrowserVisibilityUnavailableError(request.visibility);
    }
    const targetId = await this.resolveTarget(request);
    const runtime = this.provider
      .status()
      .find(
        (candidate) =>
          candidate.profile_partition_id === request.profile_partition_id,
      );
    if (!runtime) {
      throw new Error(
        `Managed runtime disappeared for partition ${request.profile_partition_id}`,
      );
    }
    const data = await this.registry.runTargetMutation(
      request.context,
      targetId,
      async (signal) => {
        if (signal.aborted) throw signal.reason;
        const page = this.provider.getPage(targetId);
        const commandResult = await executePageCommand(page, request.command);
        if (signal.aborted) throw signal.reason;
        return commandResult;
      },
    );
    return {
      target_id: targetId,
      runtime_id: runtime.runtime_id,
      browser_pid: runtime.browser_pid,
      visibility: "hidden",
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
      return policy?.profilePartitionId === request.profile_partition_id;
    });
    if (ownedTargetId) {
      this.assertTargetPolicy(ownedTargetId, request);
      return ownedTargetId;
    }
    return this.acquireTarget(request);
  }

  private async acquireTarget(
    request: BrowserTargetCommandRequest,
  ): Promise<string> {
    this.registry.touchSession(request.context);
    const providerRequest: ManagedBrowserTargetRequest = {
      profile_partition_id: request.profile_partition_id,
      isolated: request.isolated,
      ephemeral: request.ephemeral,
      ...(request.profile_id ? { profile_id: request.profile_id } : {}),
    };
    const target = await this.provider.acquireTarget(providerRequest);
    try {
      this.registry.claimTarget(request.context, {
        target_id: target.target_id,
        provider: "managed",
        profile_partition_id: request.profile_partition_id,
        visibility: "hidden",
        lifetime: "session",
      });
    } catch (error) {
      await this.provider.releaseTarget(target.target_id);
      throw error;
    }
    this.targetPolicies.set(target.target_id, {
      profilePartitionId: request.profile_partition_id,
      isolated: request.isolated,
      ephemeral: request.ephemeral,
      ...(request.profile_id ? { profileId: request.profile_id } : {}),
    });
    this.addSessionTarget(request.context.agent_session_id, target.target_id);
    return target.target_id;
  }

  private assertTargetPolicy(
    targetId: string,
    request: BrowserTargetCommandRequest,
  ): void {
    const policy = this.targetPolicies.get(targetId);
    if (!policy) return;
    if (
      policy.profilePartitionId !== request.profile_partition_id ||
      policy.isolated !== request.isolated ||
      policy.ephemeral !== request.ephemeral ||
      policy.profileId !== request.profile_id
    ) {
      throw new BrowserTargetPolicyError(targetId);
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
    for (const targetId of targetIds) {
      await this.provider.releaseTarget(targetId);
      this.targetPolicies.delete(targetId);
      this.removeSessionTarget(agentSessionId, targetId);
    }
    return leases;
  }

  private async releaseLeases(leases: BrowserTargetLease[]): Promise<void> {
    for (const lease of leases) {
      await this.provider.releaseTarget(lease.target_id);
      this.targetPolicies.delete(lease.target_id);
      this.removeSessionTarget(lease.owner_session_id, lease.target_id);
    }
  }

  private async releasePendingSessionTargets(
    agentSessionId: string,
  ): Promise<void> {
    const pending = this.sessionTargetIds.get(agentSessionId);
    if (!pending || pending.size === 0) return;
    await this.releaseSessionTargets(agentSessionId, []);
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

class BrowserVisibilityUnavailableError extends Error {
  readonly code = "browser_visibility_unavailable";
  readonly retryable = false;
  readonly suggestion =
    "Use visibility=hidden with the managed provider, or install/connect the Chrome provider for explicit background work.";

  constructor(visibility: string) {
    super(
      `The managed browser provider cannot satisfy visibility=${visibility}`,
    );
    this.name = "BrowserVisibilityUnavailableError";
  }
}

class BrowserTargetPolicyError extends Error {
  readonly code = "browser_target_policy_mismatch";
  readonly retryable = false;
  readonly suggestion =
    "Create a new target when changing profile partition, isolation, persistence, or source profile.";

  constructor(targetId: string) {
    super(`Browser target ${targetId} is bound to a different runtime policy`);
    this.name = "BrowserTargetPolicyError";
  }
}

async function executePageCommand(
  page: ReturnType<ManagedBrowserProvider["getPage"]>,
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
