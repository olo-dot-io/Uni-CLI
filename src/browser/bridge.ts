/**
 * @owner       src/browser/bridge.ts
 * @does        Expose the browser page interface over the shared Browser Runtime Broker without caller-owned Chrome or legacy transport fallback.
 * @needs       node:crypto, node:fs/promises, src/browser invocation-context/invocation-scope/runtime-launch/runtime-protocol/runtime-transport, src/types.ts
 * @feeds       browser-backed engine steps, browser operator/generate/record/explore commands, tests/unit/browser-bridge.test.ts
 * @breaks      Broker/provider/lifecycle failures retain their structured code, suggestion, and retryability; no provider or visibility fallback occurs.
 * @invariants  Every page command carries one Agent session, turn, profile partition, provider, and visibility; close ends a turn while closeWindow ends only the owning session.
 * @side-effects Lazily starts the broker, starts/touches one logical session, executes broker commands, and may write an explicitly requested screenshot file.
 * @perf        One local authenticated IPC round trip per page command; target and browser runtime reuse are broker-owned.
 * @concurrency Broker target queues serialize one target while AsyncLocalStorage keeps concurrent Agent identities independent.
 * @test        tests/unit/browser-bridge.test.ts, tests/integration/browser-runtime-autostart.test.ts, tests/integration/browser-runtime-broker.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

import {
  createBrowserInvocationContext,
  type BrowserInvocationContext,
} from "./invocation-context.js";
import {
  createBrowserInvocationScope,
  currentBrowserInvocationScope,
  registerBrowserTurnFinalizer,
  type BrowserInvocationScope,
  type BrowserProvider,
} from "./invocation-scope.js";
import { ensureBrowserRuntimeBroker } from "./runtime-launch.js";
import type {
  BrowserChromeTargetClaimRequest,
  BrowserPageCommand,
  BrowserTargetCommandRequest,
  BrowserTargetCommandResult,
} from "./runtime-protocol.js";
import type {
  ChromeNativeTab,
  ChromeNativeTarget,
} from "./chrome-native-protocol.js";
import type { BrowserRuntimeBrokerClient } from "./runtime-transport.js";
import type { BrowserSessionLeaseTarget } from "../engine/browser/session-lease.js";
import type {
  IPage,
  NetworkRequest,
  ScreenshotOptions,
  SnapshotOptions,
} from "../types.js";

export interface BrowserBridgeConnectOptions {
  timeout?: number;
  runtimeRoot?: string;
  workspace?: string;
  context?: BrowserInvocationContext;
  sessionId?: string;
  turnId?: string;
  provider?: BrowserProvider;
  visibility?: "hidden" | "background" | "foreground";
  profilePartitionId?: string;
  isolated?: boolean;
  ephemeral?: boolean;
  profileId?: string;
}

export class BridgeConnectionError extends Error {
  readonly code = "browser_broker_unavailable";
  readonly retryable = true;
  readonly suggestion = "Run `unicli browser doctor --json` and retry.";
  readonly alternatives = [
    "unicli browser broker start",
    "unicli browser doctor",
  ];

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BridgeConnectionError";
  }

  toAgentJSON(): Record<string, unknown> {
    return {
      error: this.message,
      code: this.code,
      retryable: this.retryable,
      step: -1,
      action: "browser_connect",
      suggestion: this.suggestion,
      alternatives: this.alternatives,
      exit_code: 69,
    };
  }
}

export class BrowserBridge {
  private page: BrowserBrokerPage | null = null;
  private connection: Promise<BrowserBrokerPage> | null = null;
  private pendingOptions: BrowserBridgeConnectOptions | null = null;
  private state: "idle" | "connecting" | "connected" | "closed" = "idle";

  async connect(options: BrowserBridgeConnectOptions = {}): Promise<IPage> {
    if (this.state === "connected" && this.page) return this.page;
    if (this.state === "closed") {
      throw new BridgeConnectionError(
        "A closed BrowserBridge cannot be reconnected; create a new bridge for a new invocation",
      );
    }
    if (this.connection) {
      if (!sameConnectOptions(this.pendingOptions ?? {}, options)) {
        throw new BridgeConnectionError(
          "Concurrent BrowserBridge.connect calls declared conflicting invocation options",
        );
      }
      return this.connection;
    }
    this.state = "connecting";
    const scope = resolveBridgeScope(options);
    this.pendingOptions = { ...options };
    const connection = this.open(scope, options);
    this.connection = connection;
    try {
      return await connection;
    } catch (error) {
      this.resetAfterConnectFailure();
      if (hasStructuredBrowserError(error)) throw error;
      throw new BridgeConnectionError(
        `Browser broker connection failed: ${errorMessage(error)}`,
        { cause: error },
      );
    } finally {
      if (this.connection === connection) {
        this.connection = null;
        this.pendingOptions = null;
      }
    }
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    const page = this.page ?? (this.connection ? await this.connection : null);
    try {
      await page?.close();
    } finally {
      this.page = null;
      this.state = "closed";
    }
  }

  private async open(
    scope: BrowserInvocationScope,
    options: BrowserBridgeConnectOptions,
  ): Promise<BrowserBrokerPage> {
    const { client } = await ensureBrowserRuntimeBroker({
      runtimeRoot: options.runtimeRoot,
      timeoutMs: options.timeout,
    });
    await client.requestOrThrow({
      id: randomUUID(),
      action: "session.start",
      context: scope.context,
    });
    const page = new BrowserBrokerPage(client, scope);
    this.page = page;
    this.state = "connected";
    registerBrowserTurnFinalizer(turnKey(scope.context), () => page.close());
    return page;
  }

  private resetAfterConnectFailure(): void {
    if (this.state !== "closed") this.state = "idle";
  }
}

export interface BrowserNetworkCaptureEntry {
  url: string;
  method: string;
  status: number;
  contentType: string;
  size: number;
  timestamp?: number;
  remoteIPAddress?: string;
  remotePort?: number;
  responseBody?: string;
}

export class BrowserBrokerPage implements IPage {
  private targetId: string | undefined;
  private ended = false;
  private readonly networkHistory: NetworkRequest[] = [];

  constructor(
    private readonly client: BrowserRuntimeBrokerClient,
    readonly scope: BrowserInvocationScope,
  ) {}

  async browserTargetInfo(): Promise<BrowserSessionLeaseTarget | null> {
    if (!this.targetId) return null;
    const [url, title] = await Promise.all([this.url(), this.title()]);
    return {
      kind: "broker-target",
      captured_at: new Date().toISOString(),
      target_id: this.targetId,
      provider: this.scope.provider,
      visibility: this.scope.visibility,
      url,
      title,
      owned: true,
    };
  }

  async goto(
    url: string,
    options?: { settleMs?: number; waitUntil?: string },
  ): Promise<void> {
    await this.command({
      method: "navigate",
      url,
      ...(options?.settleMs === undefined
        ? {}
        : { settle_ms: options.settleMs }),
    });
  }

  evaluate(script: string): Promise<unknown> {
    return this.command({ method: "evaluate", expression: script });
  }

  async wait(seconds: number): Promise<void> {
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new TypeError("Browser wait seconds must be a non-negative number");
    }
    await delay(seconds * 1_000);
  }

  async waitForSelector(selector: string, timeout = 10_000): Promise<void> {
    const deadline = Date.now() + timeout;
    const selectorJson = JSON.stringify(selector);
    while (Date.now() < deadline) {
      if (await this.evaluate(`!!document.querySelector(${selectorJson})`)) {
        return;
      }
      await delay(200);
    }
    throw new Error(`waitForSelector timed out: ${selector}`);
  }

  async waitFor(condition: number | string, timeout?: number): Promise<void> {
    if (typeof condition === "number") {
      if (!Number.isFinite(condition) || condition < 0) {
        throw new TypeError(
          "Browser wait milliseconds must be a non-negative number",
        );
      }
      await delay(condition);
      return;
    }
    await this.waitForSelector(condition, timeout);
  }

  async click(selector: string): Promise<void> {
    await this.command({ method: "click", selector });
  }

  async type(selector: string, text: string): Promise<void> {
    await this.command({ method: "type", selector, text });
  }

  async press(key: string, modifiers?: string[]): Promise<void> {
    await this.command({
      method: "press",
      key,
      ...(modifiers ? { modifiers } : {}),
    });
  }

  async insertText(text: string): Promise<void> {
    await this.command({ method: "insert_text", text });
  }

  async scroll(direction: "down" | "up" | "bottom" | "top"): Promise<void> {
    await this.command({ method: "scroll", direction });
  }

  async autoScroll(options?: {
    maxScrolls?: number;
    delay?: number;
  }): Promise<void> {
    const maxScrolls = options?.maxScrolls ?? 20;
    const waitMilliseconds = options?.delay ?? 1_000;
    for (let index = 0; index < maxScrolls; index += 1) {
      const atBottom = await this.evaluate(
        "(() => { window.scrollBy(0, window.innerHeight); return (window.scrollY + window.innerHeight) >= document.body.scrollHeight - 50; })()",
      );
      if (atBottom) return;
      await delay(waitMilliseconds);
    }
  }

  async nativeClick(x: number, y: number): Promise<void> {
    await this.sendCDP("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await this.sendCDP("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }

  nativeKeyPress(key: string, modifiers?: string[]): Promise<void> {
    return this.press(key, modifiers);
  }

  async setFileInput(selector: string, files: string[]): Promise<void> {
    await this.command({ method: "set_file_input", selector, files });
  }

  async cookies(): Promise<Record<string, string>> {
    return expectStringRecord(
      await this.command({ method: "cookies" }),
      "cookies",
    );
  }

  async title(): Promise<string> {
    return expectString(await this.command({ method: "title" }), "title");
  }

  async url(): Promise<string> {
    return expectString(await this.command({ method: "url" }), "url");
  }

  async snapshot(options?: SnapshotOptions): Promise<string> {
    const { snapshotWithFingerprint } = await import("./snapshot-helpers.js");
    return snapshotWithFingerprint(this, options);
  }

  async screenshot(options?: ScreenshotOptions): Promise<Buffer> {
    const encoded = expectString(
      await this.command({
        method: "screenshot",
        ...(options?.format ? { format: options.format } : {}),
        ...(options?.quality === undefined ? {} : { quality: options.quality }),
        ...(options?.fullPage === undefined
          ? {}
          : { full_page: options.fullPage }),
        ...(options?.clip ? { clip: options.clip } : {}),
      }),
      "screenshot",
    );
    const bytes = Buffer.from(encoded, "base64");
    if (options?.path) await writeFile(options.path, bytes);
    return bytes;
  }

  async startNetworkCapture(pattern?: string): Promise<boolean> {
    const result = await this.command({
      method: "network_capture_start",
      ...(pattern ? { pattern } : {}),
    });
    if (result !== true) {
      throw new TypeError(
        "Browser network capture start returned invalid data",
      );
    }
    return true;
  }

  async readNetworkCapture(): Promise<BrowserNetworkCaptureEntry[]> {
    return expectNetworkEntries(
      await this.command({ method: "network_capture_read" }),
    );
  }

  async readDialogs(clearRecent = false): Promise<unknown> {
    return this.command({
      method: "dialog_read",
      clear_recent: clearRecent,
    });
  }

  async respondDialog(options: {
    action: "accept" | "dismiss";
    promptText?: string;
    dialogId?: string;
  }): Promise<unknown> {
    return this.command({
      method: "dialog_respond",
      action: options.action,
      ...(options.promptText === undefined
        ? {}
        : { prompt_text: options.promptText }),
      ...(options.dialogId === undefined
        ? {}
        : { dialog_id: options.dialogId }),
    });
  }

  readDownloads(limit: number): Promise<unknown> {
    return this.command({ method: "downloads_read", limit });
  }

  async tabs(): Promise<ChromeNativeTab[] | BrowserSessionLeaseTarget[]> {
    if (this.scope.provider === "chrome") {
      return this.client.requestOrThrow<ChromeNativeTab[]>({
        id: randomUUID(),
        action: "chrome.tabs.list",
        context: this.scope.context,
      });
    }
    if (!this.targetId) await this.url();
    const target = await this.browserTargetInfo();
    return target ? [target] : [];
  }

  async claimChromeTab(tabId: number): Promise<ChromeNativeTarget> {
    if (this.scope.provider !== "chrome") {
      throw new Error("Chrome tab claims require the Chrome provider");
    }
    const request: BrowserChromeTargetClaimRequest = {
      id: randomUUID(),
      action: "chrome.target.claim",
      context: this.scope.context,
      tab_id: tabId,
      visibility:
        this.scope.visibility === "foreground" ? "foreground" : "background",
      profile_partition_id: this.scope.profilePartitionId,
    };
    const target =
      await this.client.requestOrThrow<ChromeNativeTarget>(request);
    this.targetId = target.target_id;
    return target;
  }

  async networkRequests(): Promise<NetworkRequest[]> {
    const captured = (await this.readNetworkCapture()).map((entry) => ({
      url: entry.url,
      method: entry.method,
      status: entry.status,
      type: entry.contentType,
      size: entry.size,
      timestamp: entry.timestamp ?? Date.now(),
      ...(entry.remoteIPAddress
        ? { remoteIPAddress: entry.remoteIPAddress }
        : {}),
      ...(entry.remotePort === undefined
        ? {}
        : { remotePort: entry.remotePort }),
    }));
    this.networkHistory.push(...captured);
    if (this.networkHistory.length > 500) {
      this.networkHistory.splice(0, this.networkHistory.length - 500);
    }
    return [...this.networkHistory];
  }

  async addInitScript(source: string): Promise<void> {
    await this.sendCDP("Page.addScriptToEvaluateOnNewDocument", { source });
  }

  sendCDP(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    return this.command({
      method: "cdp",
      cdp_method: method,
      ...(params ? { params } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
    });
  }

  async close(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.client.requestOrThrow({
      id: randomUUID(),
      action: "turn.end",
      context: this.scope.context,
    });
  }

  async closeWindow(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.client.requestOrThrow({
      id: randomUUID(),
      action: "session.end",
      agent_session_id: this.scope.context.agent_session_id,
    });
  }

  private async command(command: BrowserPageCommand): Promise<unknown> {
    if (this.ended) {
      throw new Error(
        `Browser turn ${this.scope.context.turn_id} has already ended`,
      );
    }
    const result = await this.client.requestOrThrow<BrowserTargetCommandResult>(
      this.targetCommand(command),
    );
    this.targetId = result.target_id;
    return result.data;
  }

  private targetCommand(
    command: BrowserPageCommand,
  ): BrowserTargetCommandRequest {
    const base = {
      id: randomUUID(),
      action: "target.command" as const,
      context: this.scope.context,
      ...(this.targetId ? { target_id: this.targetId } : {}),
      profile_partition_id: this.scope.profilePartitionId,
      command,
    };
    if (this.scope.provider === "managed") {
      return {
        ...base,
        provider: "managed",
        visibility: "hidden",
        isolated: this.scope.isolated,
        ephemeral: this.scope.ephemeral,
        ...(this.scope.profileId ? { profile_id: this.scope.profileId } : {}),
      };
    }
    if (this.scope.provider === "remote") {
      return {
        ...base,
        provider: "remote",
        visibility: "hidden",
      };
    }
    return {
      ...base,
      provider: "chrome",
      visibility:
        this.scope.visibility === "foreground" ? "foreground" : "background",
    };
  }
}

function resolveBridgeScope(
  options: BrowserBridgeConnectOptions,
): BrowserInvocationScope {
  const ambient = currentBrowserInvocationScope();
  if (ambient) {
    assertAmbientOptions(ambient, options);
    return ambient;
  }
  const partition =
    options.profilePartitionId ?? options.workspace ?? "default";
  const context =
    options.context ??
    createBrowserInvocationContext({
      transport: "cli",
      agentSessionId: options.sessionId,
      turnId: options.turnId,
      profilePartitionId: partition,
    });
  return createBrowserInvocationScope({
    context,
    provider: options.provider,
    visibility: options.visibility,
    profilePartitionId: partition,
    isolated: options.isolated,
    ephemeral: options.ephemeral,
    profileId: options.profileId,
  });
}

function assertAmbientOptions(
  ambient: BrowserInvocationScope,
  options: BrowserBridgeConnectOptions,
): void {
  const declaredPartition = options.profilePartitionId ?? options.workspace;
  const conflicts =
    (options.context &&
      !sameInvocationContext(options.context, ambient.context)) ||
    (options.sessionId &&
      options.sessionId !== ambient.context.agent_session_id) ||
    (options.turnId && options.turnId !== ambient.context.turn_id) ||
    (options.provider && options.provider !== ambient.provider) ||
    (options.visibility && options.visibility !== ambient.visibility) ||
    (declaredPartition && declaredPartition !== ambient.profilePartitionId) ||
    (options.isolated !== undefined && options.isolated !== ambient.isolated) ||
    (options.ephemeral !== undefined &&
      options.ephemeral !== ambient.ephemeral) ||
    (options.profileId !== undefined &&
      options.profileId !== ambient.profileId);
  if (conflicts) {
    throw new BridgeConnectionError(
      "Browser connection options conflict with the trusted invocation scope",
    );
  }
}

function sameInvocationContext(
  left: BrowserInvocationContext,
  right: BrowserInvocationContext,
): boolean {
  return (
    left.agent_session_id === right.agent_session_id &&
    left.turn_id === right.turn_id &&
    left.transport === right.transport &&
    left.profile_partition_id === right.profile_partition_id
  );
}

function sameConnectOptions(
  left: BrowserBridgeConnectOptions,
  right: BrowserBridgeConnectOptions,
): boolean {
  return (
    left.timeout === right.timeout &&
    left.runtimeRoot === right.runtimeRoot &&
    (left.profilePartitionId ?? left.workspace) ===
      (right.profilePartitionId ?? right.workspace) &&
    sameOptionalInvocationContext(left.context, right.context) &&
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId &&
    left.provider === right.provider &&
    left.visibility === right.visibility &&
    left.isolated === right.isolated &&
    left.ephemeral === right.ephemeral &&
    left.profileId === right.profileId
  );
}

function sameOptionalInvocationContext(
  left: BrowserInvocationContext | undefined,
  right: BrowserInvocationContext | undefined,
): boolean {
  if (!left || !right) return left === right;
  return sameInvocationContext(left, right);
}

function turnKey(context: BrowserInvocationContext): string {
  return `${context.agent_session_id}\0${context.turn_id}`;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`Browser ${label} returned invalid data`);
  }
  return value;
}

function expectStringRecord(
  value: unknown,
  label: string,
): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Browser ${label} returned invalid data`);
  }
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) {
    throw new TypeError(`Browser ${label} returned non-string values`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function expectNetworkEntries(value: unknown): BrowserNetworkCaptureEntry[] {
  if (!Array.isArray(value) || value.some((entry) => !isNetworkEntry(entry))) {
    throw new TypeError("Browser network capture returned invalid data");
  }
  return value;
}

function isNetworkEntry(value: unknown): value is BrowserNetworkCaptureEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.url === "string" &&
    typeof entry.method === "string" &&
    typeof entry.status === "number" &&
    typeof entry.contentType === "string" &&
    typeof entry.size === "number"
  );
}

function hasStructuredBrowserError(
  error: unknown,
): error is Error & { code: string; suggestion: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    "suggestion" in error &&
    typeof error.suggestion === "string"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
