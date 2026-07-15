/**
 * @owner       src/browser/chrome-provider.ts
 * @does        Broker Chrome native-host registration, long polling, command correlation, target metadata, disconnect recovery, and exact provider errors.
 * @needs       node:crypto, src/browser/chrome-native-protocol.ts, runtime-protocol.ts (type only)
 * @feeds       src/browser/runtime-broker.ts, native-host-main.ts, browser status/doctor
 * @breaks      ChromeProviderError on absent/conflicting/stale hosts, protocol mismatch, unknown targets/results, extension refusal, timeout, or disconnect.
 * @invariants  One live native host owns the extension channel; every command resolves exactly once; claimed tabs remain open on cleanup while owned task tabs close.
 * @side-effects Holds long-poll promises, queues extension commands, tracks Chrome targets, and rejects work on disconnect/close.
 * @perf        O(1) command/result correlation and target lookup; tabs list cost is extension/Chrome API dependent.
 * @concurrency Native commands are serialized by one host; broker target queues establish mutation order before dispatch.
 * @test        tests/unit/chrome-provider.test.ts, tests/integration/browser-extension-background.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import { randomUUID } from "node:crypto";

import {
  CHROME_EXTENSION_ID,
  CHROME_NATIVE_PROTOCOL_VERSION,
  chromeTargetId,
  type ChromeNativeCommand,
  type ChromeNativeHello,
  type ChromeNativeResult,
  type ChromeNativeTab,
  type ChromeNativeTarget,
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
}

interface ChromeProviderOptions {
  now?: () => number;
  commandTimeoutMs?: number;
  hostTtlMs?: number;
  pollTimeoutMs?: number;
}

interface RegisteredHost {
  hostInstanceId: string;
  hello: ChromeNativeHello;
  lastSeenMs: number;
  waiter: ((command: ChromeNativeCommand | null) => void) | null;
  pollTimer: ReturnType<typeof setTimeout> | null;
}

interface PendingCommand {
  command: ChromeNativeCommand;
  resolve: (result: ChromeNativeResult) => void;
  reject: (error: ChromeProviderError) => void;
  timer: ReturnType<typeof setTimeout>;
  dispatched: boolean;
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

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_HOST_TTL_MS = 30_000;
const DEFAULT_POLL_TIMEOUT_MS = 15_000;

export class ChromeProviderError extends Error {
  readonly retryable: boolean;
  readonly suggestion: string;

  constructor(
    readonly code: ChromeProviderErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ChromeProviderError";
    this.retryable =
      code === "chrome_provider_unavailable" ||
      code === "chrome_provider_timeout" ||
      code === "chrome_provider_disconnected";
    this.suggestion = chromeProviderSuggestion(code);
  }
}

export class ChromeBrowserProvider {
  private readonly now: () => number;
  private readonly commandTimeoutMs: number;
  private readonly hostTtlMs: number;
  private readonly pollTimeoutMs: number;
  private readonly queued: PendingCommand[] = [];
  private readonly pending = new Map<string, PendingCommand>();
  private readonly targets = new Map<string, ChromeTargetRecord>();
  private host: RegisteredHost | null = null;
  private closed = false;

  constructor(options: ChromeProviderOptions = {}) {
    this.now = options.now ?? Date.now;
    this.commandTimeoutMs =
      options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.hostTtlMs = options.hostTtlMs ?? DEFAULT_HOST_TTL_MS;
    this.pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  }

  registerHost(hostInstanceId: string, hello: ChromeNativeHello): void {
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
      return;
    }
    this.host = {
      hostInstanceId,
      hello,
      lastSeenMs: this.now(),
      waiter: null,
      pollTimer: null,
    };
  }

  poll(hostInstanceId: string): Promise<ChromeNativeCommand | null> {
    const host = this.requireHost(hostInstanceId);
    host.lastSeenMs = this.now();
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

  async acquireTarget(
    visibility: "background" | "foreground",
  ): Promise<ChromeNativeTarget> {
    const browserSessionId = this.requireBrowserSessionId();
    const result = await this.dispatch({
      type: "command",
      request_id: randomUUID(),
      action: "target.allocate",
      visibility,
    });
    const target = readChromeTarget(result, visibility, browserSessionId);
    this.targets.set(target.target_id, { ...target, browserSessionId });
    return target;
  }

  async claimTarget(
    tabId: number,
    visibility: "background" | "foreground",
  ): Promise<ChromeNativeTarget> {
    const browserSessionId = this.requireBrowserSessionId();
    const result = await this.dispatch({
      type: "command",
      request_id: randomUUID(),
      action: "target.claim",
      tab_id: tabId,
      visibility,
    });
    const target = readChromeTarget(result, visibility, browserSessionId);
    this.targets.set(target.target_id, { ...target, browserSessionId });
    return target;
  }

  async execute(
    targetId: string,
    visibility: "background" | "foreground",
    command: BrowserPageCommand,
  ): Promise<unknown> {
    const target = this.requireTarget(targetId);
    const result = await this.dispatch({
      type: "command",
      request_id: randomUUID(),
      action: "page.command",
      target_id: target.target_id,
      tab_id: target.tab_id,
      visibility,
      command,
    });
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
      this.targets.delete(targetId);
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
    this.targets.delete(targetId);
  }

  status(): ChromeProviderStatus {
    this.expireStaleHost();
    const host = this.host;
    const liveTargetCount = host
      ? [...this.targets.values()].filter(
          (target) => target.browserSessionId === host.hello.browser_session_id,
        ).length
      : 0;
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
      stale_target_count: this.targets.size - liveTargetCount,
    };
  }

  targetIdForTab(tabId: number): string {
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.disconnect(
      new ChromeProviderError(
        "chrome_provider_disconnected",
        "Chrome provider closed",
      ),
    );
    this.targets.clear();
  }

  private dispatch(command: ChromeNativeCommand): Promise<unknown> {
    this.assertOpen();
    this.expireStaleHost();
    if (!this.host) {
      return Promise.reject(
        new ChromeProviderError(
          "chrome_provider_unavailable",
          "The Uni-CLI Chrome extension native host is not connected",
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const pending: PendingCommand = {
        command,
        resolve: (result) => {
          if (!result.ok) {
            reject(readExtensionError(result));
            return;
          }
          resolve(result.data);
        },
        reject,
        timer: setTimeout(() => {
          this.pending.delete(command.request_id);
          const queueIndex = this.queued.indexOf(pending);
          if (queueIndex >= 0) this.queued.splice(queueIndex, 1);
          reject(
            new ChromeProviderError(
              "chrome_provider_timeout",
              `Chrome command ${command.action} timed out after ${String(this.commandTimeoutMs)}ms`,
            ),
          );
        }, this.commandTimeoutMs),
        dispatched: false,
      };
      this.pending.set(command.request_id, pending);
      this.queued.push(pending);
      this.wakePoller();
    });
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

  private takeQueuedCommand(): ChromeNativeCommand | null {
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
      pending.reject(error);
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
    !isUuid(hello.browser_session_id)
  ) {
    throw protocolResultError("Chrome native host hello identity is invalid");
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

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
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
  };
  error.name = "ChromeExtensionError";
  error.code = result.error.code;
  error.suggestion = result.error.suggestion;
  error.retryable = result.error.retryable;
  return error;
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
