/**
 * @owner       src/browser/chrome-provider.ts
 * @does        Broker Chrome native-host registration, durable inventory reconciliation, target-free bounded content search, long polling, command correlation, target metadata, disconnect recovery, and exact provider errors.
 * @needs       node:crypto, src/browser/chrome-native-protocol.ts, runtime-protocol.ts (type only)
 * @feeds       src/browser/runtime-broker.ts, native-host-main.ts, browser status/doctor
 * @breaks      ChromeProviderError on absent/conflicting/stale hosts, protocol mismatch, unknown targets/results, extension refusal, timeout, or disconnect.
 * @invariants  One live native host owns the extension channel; every command resolves exactly once; content search never creates a target record; canceled queued commands are never dispatched; a dispatched deadline retires the entire host generation instead of waiting forever for a late result; authoritative replacement hello inventory invalidates missing targets and immediately re-enables retained orphan cleanup; orphan finalization and a new claim of the same tab never overlap; claimed tabs remain open while owned task tabs close.
 * @side-effects Holds long-poll promises, queues extension commands, tracks Chrome targets, and rejects work on disconnect/close.
 * @perf        O(1) command/result correlation and target lookup; content-search work is extension-bounded and provider validation is O(result limit).
 * @concurrency Native commands are serialized by one host; broker target queues establish owned mutation order; per-target reconciliation promises linearize orphan cleanup before a new claim.
 * @test        tests/unit/chrome-provider.test.ts, tests/integration/browser-extension-background.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import { randomUUID } from "node:crypto";

import {
  CHROME_CONTENT_SEARCH_MAX_RESULTS,
  CHROME_EXTENSION_ID,
  CHROME_NATIVE_COMMAND_DEADLINE_MS,
  CHROME_NATIVE_PROTOCOL_VERSION,
  chromeTargetId,
  type ChromeNativeBrokerCommand,
  type ChromeNativeHello,
  type ChromeNativeResult,
  type ChromeNativeTab,
  type ChromeNativeTarget,
  type ChromeContentSearchFailure,
  type ChromeContentSearchMatch,
  type ChromeContentSearchQuery,
  type ChromeContentSearchResult,
} from "./chrome-native-protocol.js";
import type { BrowserPageCommand } from "./runtime-protocol.js";

export interface ChromeProviderStatus {
  connected: boolean;
  host_instance_id?: string;
  browser_session_id?: string;
  extension_id?: string;
  extension_version?: string;
  protocol_version: number;
  last_seen_ms?: number;
  queued_commands: number;
  in_flight_commands: number;
  target_count: number;
  stale_target_count: number;
  reconciling_target_count: number;
  reconciliation_error_count: number;
}

export interface ChromeHostRegistration {
  lost_target_ids: string[];
  orphan_target_ids: string[];
}

interface ChromeProviderOptions {
  now?: () => number;
  commandTimeoutMs?: number;
  hostTtlMs?: number;
  pollTimeoutMs?: number;
  hostWaitTimeoutMs?: number;
  hostShutdownTimeoutMs?: number;
}

interface RegisteredHost {
  hostInstanceId: string;
  hello: ChromeNativeHello;
  lastSeenMs: number;
  waiter: ((command: ChromeNativeBrokerCommand | null) => void) | null;
  pollTimer: ReturnType<typeof setTimeout> | null;
}

interface PendingCommand {
  command: ChromeNativeBrokerCommand;
  resolve: (result: ChromeNativeResult) => void;
  reject: (error: ChromeProviderError) => void;
  timer: ReturnType<typeof setTimeout>;
  dispatched: boolean;
  consumerSettled: boolean;
  signal?: AbortSignal;
  abortHandler?: () => void;
  onLateResult?: (result: ChromeNativeResult) => void;
}

interface HostWaiter {
  resolve: () => void;
  reject: (error: ChromeProviderError) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

interface ChromeTargetRecord extends ChromeNativeTarget {
  browserSessionId: string;
}

type ChromeProviderErrorCode =
  | "chrome_provider_unavailable"
  | "chrome_provider_conflict"
  | "chrome_provider_protocol_invalid"
  | "chrome_provider_timeout"
  | "chrome_provider_disconnected"
  | "chrome_target_not_found";

const DEFAULT_COMMAND_TIMEOUT_MS = CHROME_NATIVE_COMMAND_DEADLINE_MS + 10_000;
const DEFAULT_HOST_TTL_MS = 30_000;
const DEFAULT_POLL_TIMEOUT_MS = 15_000;
const DEFAULT_HOST_WAIT_TIMEOUT_MS = 5_000;
const DEFAULT_HOST_SHUTDOWN_TIMEOUT_MS = 1_000;

export class ChromeProviderError extends Error {
  readonly retryable: boolean;
  readonly suggestion: string;
  readonly outcome_ambiguous: boolean;

  constructor(
    readonly code: ChromeProviderErrorCode,
    message: string,
    options?: ErrorOptions & { outcomeAmbiguous?: boolean },
  ) {
    super(message, options);
    this.name = "ChromeProviderError";
    this.retryable =
      code === "chrome_provider_unavailable" ||
      code === "chrome_provider_timeout" ||
      code === "chrome_provider_disconnected";
    this.suggestion = chromeProviderSuggestion(code);
    this.outcome_ambiguous = options?.outcomeAmbiguous === true;
  }
}

export class ChromeBrowserProvider {
  private readonly now: () => number;
  private readonly commandTimeoutMs: number;
  private readonly hostTtlMs: number;
  private readonly pollTimeoutMs: number;
  private readonly hostWaitTimeoutMs: number;
  private readonly hostShutdownTimeoutMs: number;
  private readonly queued: PendingCommand[] = [];
  private readonly hostWaiters = new Set<HostWaiter>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly targets = new Map<string, ChromeTargetRecord>();
  private readonly reconcilingTargets = new Map<string, Promise<void>>();
  private readonly orphanTargetIds = new Set<string>();
  private readonly orphanTokens = new Map<string, object>();
  private readonly reconciliationRetryAfterMs = new Map<string, number>();
  private reconciliationErrorCount = 0;
  private host: RegisteredHost | null = null;
  private closed = false;

  constructor(options: ChromeProviderOptions = {}) {
    this.now = options.now ?? Date.now;
    this.commandTimeoutMs =
      options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.hostTtlMs = options.hostTtlMs ?? DEFAULT_HOST_TTL_MS;
    this.pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    this.hostWaitTimeoutMs =
      options.hostWaitTimeoutMs ?? DEFAULT_HOST_WAIT_TIMEOUT_MS;
    this.hostShutdownTimeoutMs =
      options.hostShutdownTimeoutMs ?? DEFAULT_HOST_SHUTDOWN_TIMEOUT_MS;
  }

  registerHost(
    hostInstanceId: string,
    hello: ChromeNativeHello,
  ): ChromeHostRegistration {
    this.assertOpen();
    validateHostIdentity(hostInstanceId, hello);
    this.expireStaleHost();
    if (this.host && this.host.hostInstanceId !== hostInstanceId) {
      if (this.host.hello.browser_session_id === hello.browser_session_id) {
        this.disconnect(
          new ChromeProviderError(
            "chrome_provider_disconnected",
            `Chrome native host ${this.host.hostInstanceId} was superseded by a reconnect from the same browser session`,
          ),
        );
      }
    }
    if (this.host && this.host.hostInstanceId !== hostInstanceId) {
      throw new ChromeProviderError(
        "chrome_provider_conflict",
        `Chrome native host ${this.host.hostInstanceId} is already connected`,
      );
    }
    if (this.host) {
      if (
        this.host.hello.browser_session_id !== hello.browser_session_id ||
        this.host.hello.extension_id !== hello.extension_id
      ) {
        throw protocolResultError(
          "Chrome native host changed browser identity while registered",
        );
      }
      this.host.lastSeenMs = this.now();
      this.host.hello = hello;
      const registration = this.reconcileInventory(hello);
      for (const targetId of registration.orphan_target_ids) {
        this.markOrphanTarget(targetId);
      }
      this.scheduleOrphanReconciliation();
      this.resolveHostWaiters();
      return registration;
    }
    this.host = {
      hostInstanceId,
      hello,
      lastSeenMs: this.now(),
      waiter: null,
      pollTimer: null,
    };
    const registration = this.reconcileInventory(hello);
    for (const targetId of registration.orphan_target_ids) {
      this.markOrphanTarget(targetId);
    }
    this.scheduleOrphanReconciliation();
    this.resolveHostWaiters();
    return registration;
  }

  poll(hostInstanceId: string): Promise<ChromeNativeBrokerCommand | null> {
    const host = this.requireHost(hostInstanceId);
    host.lastSeenMs = this.now();
    this.scheduleOrphanReconciliation();
    const command = this.takeQueuedCommand();
    if (command) return Promise.resolve(command);
    if (host.waiter) {
      throw new ChromeProviderError(
        "chrome_provider_protocol_invalid",
        `Chrome native host ${hostInstanceId} already has an active poll`,
      );
    }
    return new Promise((resolve) => {
      host.waiter = resolve;
      host.pollTimer = setTimeout(() => {
        if (this.host !== host || host.waiter !== resolve) return;
        host.waiter = null;
        host.pollTimer = null;
        host.lastSeenMs = this.now();
        resolve(null);
      }, this.pollTimeoutMs);
    });
  }

  heartbeat(hostInstanceId: string): void {
    const host = this.requireHost(hostInstanceId);
    host.lastSeenMs = this.now();
  }

  deliver(hostInstanceId: string, result: ChromeNativeResult): void {
    const host = this.requireHost(hostInstanceId);
    host.lastSeenMs = this.now();
    const pending = this.pending.get(result.request_id);
    if (!pending || !pending.dispatched) {
      throw new ChromeProviderError(
        "chrome_provider_protocol_invalid",
        `Chrome result does not match an in-flight command: ${result.request_id}`,
      );
    }
    this.pending.delete(result.request_id);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  disconnectHost(hostInstanceId: string): void {
    if (!this.host || this.host.hostInstanceId !== hostInstanceId) return;
    this.disconnect(
      new ChromeProviderError(
        "chrome_provider_disconnected",
        `Chrome native host ${hostInstanceId} disconnected`,
      ),
    );
  }

  async listTabs(): Promise<ChromeNativeTab[]> {
    const result = await this.dispatch({
      type: "command",
      request_id: randomUUID(),
      action: "tabs.list",
    });
    return readChromeTabs(result);
  }

  async searchContent(
    search: ChromeContentSearchQuery,
    signal?: AbortSignal,
  ): Promise<ChromeContentSearchResult> {
    const result = await this.dispatch(
      {
        type: "command",
        request_id: randomUUID(),
        action: "content.search",
        search,
      },
      signal,
    );
    return readChromeContentSearchResult(result, search.query.trim());
  }

  async acquireTarget(
    visibility: "background" | "foreground",
    signal?: AbortSignal,
  ): Promise<ChromeNativeTarget> {
    const hostWait = this.waitForHost(signal);
    if (hostWait) await hostWait;
    const browserSessionId = this.requireBrowserSessionId();
    const result = await this.dispatch(
      {
        type: "command",
        request_id: randomUUID(),
        action: "target.allocate",
        visibility,
      },
      signal,
      (lateResult) =>
        this.reconcileCanceledTargetResult(
          lateResult,
          visibility,
          browserSessionId,
        ),
    );
    const target = readChromeTarget(result, visibility, browserSessionId);
    this.targets.set(target.target_id, { ...target, browserSessionId });
    return target;
  }

  async claimTarget(
    tabId: number,
    visibility: "background" | "foreground",
    signal?: AbortSignal,
  ): Promise<ChromeNativeTarget> {
    const hostWait = this.waitForHost(signal);
    if (hostWait) await hostWait;
    const browserSessionId = this.requireBrowserSessionId();
    const targetId = chromeTargetId(browserSessionId, tabId);
    await this.reconcilingTargets.get(targetId);
    this.cancelOrphanReconciliation(targetId);
    const result = await this.dispatch(
      {
        type: "command",
        request_id: randomUUID(),
        action: "target.claim",
        tab_id: tabId,
        visibility,
      },
      signal,
      (lateResult) =>
        this.reconcileCanceledTargetResult(
          lateResult,
          visibility,
          browserSessionId,
        ),
    );
    const target = readChromeTarget(result, visibility, browserSessionId);
    this.cancelOrphanReconciliation(target.target_id);
    this.targets.set(target.target_id, { ...target, browserSessionId });
    return target;
  }

  async execute(
    targetId: string,
    visibility: "background" | "foreground",
    command: BrowserPageCommand,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const target = this.requireTarget(targetId);
    const result = await this.dispatch(
      {
        type: "command",
        request_id: randomUUID(),
        action: "page.command",
        target_id: target.target_id,
        tab_id: target.tab_id,
        visibility,
        command,
      },
      signal,
    );
    if (visibility === "foreground") target.visibility = "foreground";
    return result;
  }

  async releaseTarget(
    targetId: string,
    disposition?: "close" | "release",
  ): Promise<void> {
    const target = this.targets.get(targetId);
    if (!target) return;
    const currentBrowserSessionId = this.host?.hello.browser_session_id;
    if (
      currentBrowserSessionId &&
      target.browserSessionId !== currentBrowserSessionId
    ) {
      this.forgetTarget(targetId);
      return;
    }
    await this.dispatch({
      type: "command",
      request_id: randomUUID(),
      action: "target.finalize",
      target_id: target.target_id,
      tab_id: target.tab_id,
      visibility: target.visibility,
      disposition: disposition ?? (target.owned ? "close" : "release"),
    });
    this.forgetTarget(targetId);
  }

  async shutdownHost(): Promise<boolean> {
    this.expireStaleHost();
    if (!this.host) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(
        new Error(
          `Chrome native host did not acknowledge shutdown within ${String(this.hostShutdownTimeoutMs)}ms`,
        ),
      );
    }, this.hostShutdownTimeoutMs);
    try {
      await this.dispatch(
        {
          type: "command",
          request_id: randomUUID(),
          action: "host.shutdown",
        },
        controller.signal,
      );
      return true;
    } catch (error) {
      if (controller.signal.aborted) return false;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  status(): ChromeProviderStatus {
    this.expireStaleHost();
    const host = this.host;
    const liveTargetCount = host
      ? [...this.targets.values()].filter(
          (target) =>
            target.browserSessionId === host.hello.browser_session_id &&
            !this.orphanTargetIds.has(target.target_id),
        ).length
      : 0;
    const staleTargetCount = host
      ? [...this.targets.values()].filter(
          (target) => target.browserSessionId !== host.hello.browser_session_id,
        ).length
      : this.targets.size - this.orphanTargetIds.size;
    return {
      connected: host !== null,
      ...(host
        ? {
            host_instance_id: host.hostInstanceId,
            browser_session_id: host.hello.browser_session_id,
            extension_id: host.hello.extension_id,
            extension_version: host.hello.extension_version,
            last_seen_ms: host.lastSeenMs,
          }
        : {}),
      protocol_version: CHROME_NATIVE_PROTOCOL_VERSION,
      queued_commands: this.queued.length,
      in_flight_commands: [...this.pending.values()].filter(
        (command) => command.dispatched,
      ).length,
      target_count: liveTargetCount,
      stale_target_count: staleTargetCount,
      reconciling_target_count: this.orphanTargetIds.size,
      reconciliation_error_count: this.reconciliationErrorCount,
    };
  }

  async targetIdForTab(tabId: number, signal?: AbortSignal): Promise<string> {
    const hostWait = this.waitForHost(signal);
    if (hostWait) await hostWait;
    return chromeTargetId(this.requireBrowserSessionId(), tabId);
  }

  hasLiveTarget(targetId: string): boolean {
    this.expireStaleHost();
    const target = this.targets.get(targetId);
    return Boolean(
      target &&
      this.host &&
      target.browserSessionId === this.host.hello.browser_session_id,
    );
  }

  forgetTarget(targetId: string): void {
    this.targets.delete(targetId);
    this.cancelOrphanReconciliation(targetId);
  }

  abandonTarget(targetId: string): void {
    if (!this.targets.has(targetId)) return;
    this.markOrphanTarget(targetId);
    this.scheduleOrphanReconciliation();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.disconnect(
      new ChromeProviderError(
        "chrome_provider_disconnected",
        "Chrome provider closed",
      ),
    );
    this.rejectHostWaiters(
      new ChromeProviderError(
        "chrome_provider_disconnected",
        "Chrome provider closed",
      ),
    );
    this.targets.clear();
    this.reconcilingTargets.clear();
    this.orphanTargetIds.clear();
    this.orphanTokens.clear();
    this.reconciliationRetryAfterMs.clear();
  }

  private dispatch(
    command: ChromeNativeBrokerCommand,
    signal?: AbortSignal,
    onLateResult?: (result: ChromeNativeResult) => void,
  ): Promise<unknown> {
    const hostWait = this.waitForHost(signal);
    return hostWait
      ? hostWait.then(() =>
          this.dispatchConnected(command, signal, onLateResult),
        )
      : this.dispatchConnected(command, signal, onLateResult);
  }

  private dispatchConnected(
    command: ChromeNativeBrokerCommand,
    signal?: AbortSignal,
    onLateResult?: (result: ChromeNativeResult) => void,
  ): Promise<unknown> {
    this.assertOpen();
    throwIfChromeOperationAborted(signal);
    this.expireStaleHost();
    if (!this.host) {
      throw new ChromeProviderError(
        "chrome_provider_unavailable",
        "The Uni-CLI Chrome extension native host disconnected before command admission",
      );
    }
    return new Promise((resolve, reject) => {
      let pending!: PendingCommand;
      const settleConsumer = (
        outcome:
          | { result: ChromeNativeResult }
          | { error: ChromeProviderError },
      ): void => {
        if (pending.consumerSettled) return;
        pending.consumerSettled = true;
        if (pending.signal && pending.abortHandler) {
          pending.signal.removeEventListener("abort", pending.abortHandler);
        }
        if ("error" in outcome) {
          reject(outcome.error);
          return;
        }
        if (!outcome.result.ok) {
          reject(readExtensionError(outcome.result));
          return;
        }
        resolve(outcome.result.data);
      };
      const abortHandler = (): void => {
        if (!pending.dispatched) {
          this.pending.delete(command.request_id);
          const queueIndex = this.queued.indexOf(pending);
          if (queueIndex >= 0) this.queued.splice(queueIndex, 1);
          clearTimeout(pending.timer);
        }
        settleConsumer({
          error: new ChromeProviderError(
            "chrome_provider_disconnected",
            errorMessage(signal?.reason),
            {
              cause: signal?.reason,
              outcomeAmbiguous: pending.dispatched,
            },
          ),
        });
      };
      pending = {
        command,
        resolve: (result) => {
          if (pending.consumerSettled) {
            pending.onLateResult?.(result);
            return;
          }
          settleConsumer({ result });
        },
        reject: (error) => settleConsumer({ error }),
        timer: setTimeout(() => {
          const timeoutError = new ChromeProviderError(
            "chrome_provider_timeout",
            `Chrome command ${command.action} timed out after ${String(this.commandTimeoutMs)}ms`,
          );
          if (pending.dispatched) {
            this.disconnect(timeoutError);
            return;
          }
          this.pending.delete(command.request_id);
          const queueIndex = this.queued.indexOf(pending);
          if (queueIndex >= 0) this.queued.splice(queueIndex, 1);
          settleConsumer({ error: timeoutError });
        }, this.commandTimeoutMs),
        dispatched: false,
        consumerSettled: false,
        ...(signal ? { signal, abortHandler } : {}),
        ...(onLateResult ? { onLateResult } : {}),
      };
      this.pending.set(command.request_id, pending);
      this.queued.push(pending);
      signal?.addEventListener("abort", abortHandler, { once: true });
      this.wakePoller();
    });
  }

  private reconcileCanceledTargetResult(
    result: ChromeNativeResult,
    visibility: "background" | "foreground",
    browserSessionId: string,
  ): void {
    if (!result.ok) return;
    const target = readChromeTarget(result.data, visibility, browserSessionId);
    this.targets.set(target.target_id, { ...target, browserSessionId });
    this.markOrphanTarget(target.target_id);
    this.scheduleOrphanReconciliation();
  }

  private reconcileInventory(hello: ChromeNativeHello): ChromeHostRegistration {
    const inventory = new Map<string, ChromeTargetRecord>();
    for (const candidate of hello.targets) {
      const target = readChromeTarget(
        candidate,
        candidate.visibility,
        hello.browser_session_id,
      );
      if (inventory.has(target.target_id)) {
        throw protocolResultError(
          `Chrome hello repeats target ${target.target_id}`,
        );
      }
      inventory.set(target.target_id, {
        ...target,
        browserSessionId: hello.browser_session_id,
      });
    }
    const lostTargetIds = [...this.targets.keys()]
      .filter((targetId) => !inventory.has(targetId))
      .sort();
    for (const targetId of lostTargetIds) this.forgetTarget(targetId);
    const orphanTargetIds: string[] = [];
    for (const [targetId, target] of inventory) {
      const existing = this.targets.get(targetId);
      this.targets.set(targetId, target);
      if (!existing) orphanTargetIds.push(targetId);
      if (this.orphanTargetIds.has(targetId)) {
        this.reconciliationRetryAfterMs.delete(targetId);
      }
    }
    orphanTargetIds.sort();
    return {
      lost_target_ids: lostTargetIds,
      orphan_target_ids: orphanTargetIds,
    };
  }

  private async reconcileOrphanTarget(
    targetId: string,
    orphanToken: object,
  ): Promise<void> {
    const target = this.targets.get(targetId);
    if (!target || this.orphanTokens.get(targetId) !== orphanToken) return;
    const currentBrowserSessionId = this.host?.hello.browser_session_id;
    if (
      currentBrowserSessionId &&
      target.browserSessionId !== currentBrowserSessionId
    ) {
      this.forgetTarget(targetId);
      return;
    }
    try {
      if (this.orphanTokens.get(targetId) !== orphanToken) return;
      await this.dispatch({
        type: "command",
        request_id: randomUUID(),
        action: "target.finalize",
        target_id: target.target_id,
        tab_id: target.tab_id,
        visibility: target.visibility,
        disposition: target.owned ? "close" : "release",
      });
      if (this.orphanTokens.get(targetId) === orphanToken) {
        this.forgetTarget(targetId);
      }
    } catch (error) {
      if (this.orphanTokens.get(targetId) !== orphanToken) return;
      if (isMissingChromeTargetError(error)) {
        this.forgetTarget(targetId);
        return;
      }
      this.reconciliationErrorCount += 1;
      this.reconciliationRetryAfterMs.set(targetId, this.now() + 5_000);
    }
  }

  private scheduleOrphanReconciliation(): void {
    for (const targetId of this.orphanTargetIds) {
      if (
        this.reconcilingTargets.has(targetId) ||
        (this.reconciliationRetryAfterMs.get(targetId) ?? 0) > this.now()
      ) {
        continue;
      }
      const orphanToken = this.orphanTokens.get(targetId);
      if (!orphanToken) continue;
      const reconciliation = Promise.resolve()
        .then(() => this.reconcileOrphanTarget(targetId, orphanToken))
        .finally(() => {
          if (this.reconcilingTargets.get(targetId) === reconciliation) {
            this.reconcilingTargets.delete(targetId);
          }
        });
      this.reconcilingTargets.set(targetId, reconciliation);
    }
  }

  private markOrphanTarget(targetId: string): void {
    this.orphanTargetIds.add(targetId);
    if (!this.orphanTokens.has(targetId)) {
      this.orphanTokens.set(targetId, {});
    }
  }

  private cancelOrphanReconciliation(targetId: string): void {
    this.orphanTargetIds.delete(targetId);
    this.orphanTokens.delete(targetId);
    this.reconciliationRetryAfterMs.delete(targetId);
  }

  private waitForHost(signal?: AbortSignal): Promise<void> | undefined {
    this.assertOpen();
    throwIfChromeOperationAborted(signal);
    this.expireStaleHost();
    if (this.host) return undefined;
    return this.waitForHostUntil(Date.now() + this.hostWaitTimeoutMs, signal);
  }

  private async waitForHostUntil(
    deadline: number,
    signal?: AbortSignal,
  ): Promise<void> {
    for (;;) {
      this.assertOpen();
      throwIfChromeOperationAborted(signal);
      this.expireStaleHost();
      if (this.host) return;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new ChromeProviderError(
          "chrome_provider_unavailable",
          `The Uni-CLI Chrome extension native host did not connect within ${String(this.hostWaitTimeoutMs)}ms`,
        );
      }
      await this.waitForHostRegistration(remainingMs, signal);
    }
  }

  private waitForHostRegistration(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let waiter!: HostWaiter;
      const settle = (error?: ChromeProviderError): void => {
        if (!this.hostWaiters.delete(waiter)) return;
        clearTimeout(waiter.timer);
        if (waiter.signal && waiter.abortHandler) {
          waiter.signal.removeEventListener("abort", waiter.abortHandler);
        }
        if (error) reject(error);
        else resolve();
      };
      const abortHandler = (): void => {
        settle(
          new ChromeProviderError(
            "chrome_provider_disconnected",
            errorMessage(signal?.reason),
            { cause: signal?.reason },
          ),
        );
      };
      waiter = {
        resolve: () => settle(),
        reject: (error) => settle(error),
        timer: setTimeout(() => settle(), timeoutMs),
        ...(signal ? { signal, abortHandler } : {}),
      };
      this.hostWaiters.add(waiter);
      signal?.addEventListener("abort", abortHandler, { once: true });
      if (this.host) waiter.resolve();
    });
  }

  private resolveHostWaiters(): void {
    for (const waiter of this.hostWaiters) waiter.resolve();
  }

  private rejectHostWaiters(error: ChromeProviderError): void {
    for (const waiter of this.hostWaiters) waiter.reject(error);
  }

  private wakePoller(): void {
    const host = this.host;
    if (!host?.waiter) return;
    const command = this.takeQueuedCommand();
    if (!command) return;
    const resolve = host.waiter;
    host.waiter = null;
    if (host.pollTimer) clearTimeout(host.pollTimer);
    host.pollTimer = null;
    host.lastSeenMs = this.now();
    resolve(command);
  }

  private takeQueuedCommand(): ChromeNativeBrokerCommand | null {
    const pending = this.queued.shift();
    if (!pending) return null;
    pending.dispatched = true;
    return pending.command;
  }

  private requireHost(hostInstanceId: string): RegisteredHost {
    this.assertOpen();
    this.expireStaleHost();
    if (!this.host || this.host.hostInstanceId !== hostInstanceId) {
      throw new ChromeProviderError(
        "chrome_provider_unavailable",
        `Chrome native host is not registered: ${hostInstanceId}`,
      );
    }
    return this.host;
  }

  private requireTarget(targetId: string): ChromeTargetRecord {
    const browserSessionId = this.requireBrowserSessionId();
    const target = this.targets.get(targetId);
    if (target?.browserSessionId === browserSessionId) return target;
    throw new ChromeProviderError(
      "chrome_target_not_found",
      `Chrome target is not registered: ${targetId}`,
    );
  }

  private requireBrowserSessionId(): string {
    this.assertOpen();
    this.expireStaleHost();
    if (!this.host) {
      throw new ChromeProviderError(
        "chrome_provider_unavailable",
        "The Uni-CLI Chrome extension native host is not connected",
      );
    }
    return this.host.hello.browser_session_id;
  }

  private expireStaleHost(): void {
    if (this.host && this.now() - this.host.lastSeenMs > this.hostTtlMs) {
      this.disconnect(
        new ChromeProviderError(
          "chrome_provider_disconnected",
          `Chrome native host ${this.host.hostInstanceId} exceeded its heartbeat TTL`,
        ),
      );
    }
  }

  private disconnect(error: ChromeProviderError): void {
    const host = this.host;
    this.host = null;
    if (host?.pollTimer) clearTimeout(host.pollTimer);
    host?.waiter?.(null);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        pending.dispatched && !error.outcome_ambiguous
          ? new ChromeProviderError(error.code, error.message, {
              cause: error,
              outcomeAmbiguous: true,
            })
          : error,
      );
    }
    this.pending.clear();
    this.queued.length = 0;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new ChromeProviderError(
        "chrome_provider_disconnected",
        "Chrome provider is closed",
      );
    }
  }
}

function validateHostIdentity(
  hostInstanceId: string,
  hello: ChromeNativeHello,
): void {
  if (!hostInstanceId.trim()) {
    throw protocolResultError("Chrome native host instance id is empty");
  }
  if (
    hello.type !== "hello" ||
    hello.version !== CHROME_NATIVE_PROTOCOL_VERSION ||
    hello.extension_id !== CHROME_EXTENSION_ID ||
    !hello.extension_version.trim() ||
    !isUuid(hello.browser_session_id) ||
    !Array.isArray(hello.targets)
  ) {
    throw protocolResultError("Chrome native host hello identity is invalid");
  }
  const targetIds = new Set<string>();
  for (const candidate of hello.targets) {
    const target = readChromeTarget(
      candidate,
      candidate.visibility,
      hello.browser_session_id,
    );
    if (!targetIds.add(target.target_id)) {
      throw protocolResultError(
        `Chrome native host hello repeats target ${target.target_id}`,
      );
    }
  }
}

function readChromeTarget(
  value: unknown,
  visibility: "background" | "foreground",
  browserSessionId: string,
): ChromeNativeTarget {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Record<string, unknown>).target_id !== "string" ||
    !isNonnegativeInteger((value as Record<string, unknown>).tab_id) ||
    !isNonnegativeInteger((value as Record<string, unknown>).window_id) ||
    typeof (value as Record<string, unknown>).owned !== "boolean" ||
    (value as Record<string, unknown>).visibility !== visibility ||
    !isOptionalString((value as Record<string, unknown>).url) ||
    !isOptionalString((value as Record<string, unknown>).title)
  ) {
    throw protocolResultError("Chrome target response has an invalid schema");
  }
  const record = value as unknown as ChromeNativeTarget;
  if (record.target_id !== chromeTargetId(browserSessionId, record.tab_id)) {
    throw protocolResultError(
      "Chrome target response does not match its tab identity",
    );
  }
  return record;
}

function readChromeTabs(value: unknown): ChromeNativeTab[] {
  if (!Array.isArray(value) || !value.every(isChromeTab)) {
    throw protocolResultError("Chrome tabs.list returned an invalid schema");
  }
  return value;
}

function readChromeContentSearchResult(
  value: unknown,
  expectedQuery: string,
): ChromeContentSearchResult {
  if (!isRecord(value)) {
    throw protocolResultError(
      "Chrome content.search returned an invalid schema",
    );
  }
  const limits = value.limits;
  const results = value.results;
  const failures = value.failures;
  if (
    value.query !== expectedQuery ||
    !boundedCount(value.result_count, CHROME_CONTENT_SEARCH_MAX_RESULTS) ||
    !boundedCount(value.eligible_open_tabs, 100_000) ||
    !boundedCount(value.scanned_open_tabs, 200) ||
    !boundedCount(value.matched_open_tabs, 200) ||
    !boundedCount(value.failed_open_tabs, 200) ||
    !boundedCount(value.scanned_history_items, 500) ||
    !boundedCount(value.matched_history_items, 500) ||
    value.ui_state_unchanged !== true ||
    typeof value.truncated !== "boolean" ||
    !isSearchLimits(limits) ||
    !Array.isArray(results) ||
    results.length !== value.result_count ||
    !results.every(isChromeContentSearchMatch) ||
    !Array.isArray(failures) ||
    failures.length > 20 ||
    !failures.every(isChromeContentSearchFailure)
  ) {
    throw protocolResultError(
      "Chrome content.search returned an invalid schema",
    );
  }
  return value as unknown as ChromeContentSearchResult;
}

function isSearchLimits(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    boundedPositiveInteger(value.max_results, 100) &&
    boundedPositiveInteger(value.max_tabs, 200) &&
    boundedPositiveInteger(value.max_chars_per_tab, 500_000) &&
    value.tab_concurrency === 4
  );
}

function isChromeContentSearchMatch(
  value: unknown,
): value is ChromeContentSearchMatch {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.sources) &&
    value.sources.length >= 1 &&
    value.sources.length <= 2 &&
    value.sources.every(
      (source) => source === "open_tab" || source === "history",
    ) &&
    new Set(value.sources).size === value.sources.length &&
    typeof value.url === "string" &&
    value.url.length <= 4_096 &&
    optionalBoundedString(value.title, 512) &&
    typeof value.score === "number" &&
    Number.isFinite(value.score) &&
    value.score >= 0 &&
    Array.isArray(value.match_fields) &&
    value.match_fields.length <= 3 &&
    value.match_fields.every(
      (field) => field === "title" || field === "url" || field === "content",
    ) &&
    optionalStringArray(value.snippets, 3, 320) &&
    optionalNonnegativeInteger(value.tab_id) &&
    optionalNonnegativeInteger(value.window_id) &&
    (value.active === undefined || typeof value.active === "boolean") &&
    optionalNonnegativeFinite(value.last_accessed) &&
    optionalNonnegativeFinite(value.last_visit_time) &&
    optionalNonnegativeInteger(value.visit_count)
  );
}

function isChromeContentSearchFailure(
  value: unknown,
): value is ChromeContentSearchFailure {
  if (!isRecord(value)) return false;
  return (
    value.source === "open_tab" &&
    isNonnegativeInteger(value.tab_id) &&
    optionalBoundedString(value.url, 4_096) &&
    typeof value.code === "string" &&
    value.code.length > 0 &&
    value.code.length <= 256 &&
    typeof value.message === "string" &&
    value.message.length <= 512
  );
}

function isChromeTab(value: unknown): value is ChromeNativeTab {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  return (
    isNonnegativeInteger(record.tab_id) &&
    isNonnegativeInteger(record.window_id) &&
    typeof record.active === "boolean" &&
    isOptionalString(record.url) &&
    isOptionalString(record.title) &&
    (record.last_accessed === undefined ||
      (typeof record.last_accessed === "number" &&
        Number.isFinite(record.last_accessed) &&
        record.last_accessed >= 0))
  );
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function boundedCount(value: unknown, maximum: number): value is number {
  return isNonnegativeInteger(value) && value <= maximum;
}

function boundedPositiveInteger(
  value: unknown,
  maximum: number,
): value is number {
  return isNonnegativeInteger(value) && value >= 1 && value <= maximum;
}

function optionalNonnegativeInteger(value: unknown): boolean {
  return value === undefined || isNonnegativeInteger(value);
}

function optionalNonnegativeFinite(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

function optionalBoundedString(value: unknown, maximum: number): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && value.length <= maximum)
  );
}

function optionalStringArray(
  value: unknown,
  maximumItems: number,
  maximumChars: number,
): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= maximumItems &&
      value.every(
        (item) => typeof item === "string" && item.length <= maximumChars,
      ))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfChromeOperationAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new ChromeProviderError(
    "chrome_provider_disconnected",
    errorMessage(signal.reason),
    { cause: signal.reason },
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function readExtensionError(result: ChromeNativeResult): Error {
  if (!result.error) {
    return protocolResultError(
      `Chrome result ${result.request_id} has ok=false without an error`,
    );
  }
  const error = new Error(result.error.message) as Error & {
    code: string;
    suggestion: string;
    retryable: boolean;
    outcome_ambiguous: boolean;
    target_unusable: boolean;
  };
  error.name = "ChromeExtensionError";
  error.code = result.error.code;
  error.suggestion = result.error.suggestion;
  error.retryable = result.error.retryable;
  error.outcome_ambiguous = result.error.outcome_ambiguous === true;
  error.target_unusable = result.error.target_unusable === true;
  return error;
}

export function isMissingChromeTargetError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "chrome_target_not_found" || code === "chrome_target_invalid";
}

function protocolResultError(message: string): ChromeProviderError {
  return new ChromeProviderError("chrome_provider_protocol_invalid", message);
}

function chromeProviderSuggestion(code: ChromeProviderErrorCode): string {
  switch (code) {
    case "chrome_provider_unavailable":
      return "Start Chrome with the Uni-CLI extension installed, verify the native host manifest, and retry without opening a new browser window.";
    case "chrome_provider_conflict":
      return "Close the stale Uni-CLI extension connection or wait for its host TTL before reconnecting.";
    case "chrome_provider_protocol_invalid":
      return "Upgrade the Uni-CLI broker, native host, and Chrome extension together.";
    case "chrome_provider_timeout":
      return "Inspect Chrome extension/native-host status and the broker command queue before retrying.";
    case "chrome_provider_disconnected":
      return "Reconnect the Uni-CLI Chrome extension native host and create or reclaim the target.";
    case "chrome_target_not_found":
      return "List current Chrome tabs and explicitly allocate or claim a target.";
  }
}
