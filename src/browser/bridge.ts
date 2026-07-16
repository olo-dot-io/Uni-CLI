/**
 * @owner       src/browser/bridge.ts
 * @does        Expose target-scoped page control, provider-wide Chrome content search, and foreground agent presence over the shared Browser Runtime Broker without caller-owned Chrome or legacy transport fallback.
 * @needs       node:crypto, transactional file publication, src/browser invocation-context/invocation-scope/runtime-launch/runtime-protocol/runtime-transport, src/types.ts
 * @feeds       browser-backed engine steps, browser operator/generate/record/explore commands, tests/unit/browser-bridge.test.ts
 * @breaks      Broker/provider/lifecycle failures retain their structured code, suggestion, and retryability; aborted waits surface the invocation signal reason; broker-invalidated targets are never reused; no provider or visibility fallback occurs.
 * @invariants  Every page command carries one Agent session, turn, profile partition, provider, and visibility; authoritative ownership and Chrome tab/window identity come from each broker command response rather than provider inference; provider-wide search carries the same identity without allocating a target; cached target identity is cleared whenever the broker invalidates its lease; waits, snapshots, and screenshot publication honor cancellation; close ends a turn while closeWindow ends only the owning session.
 * @side-effects Lazily starts the broker, starts/touches one logical session, executes broker commands, and may write an explicitly requested screenshot file.
 * @perf        One local authenticated IPC round trip per page command; the last exact target identity is cached from broker responses so action acknowledgements add no provider round trips.
 * @concurrency Broker target queues serialize one target while AsyncLocalStorage keeps concurrent Agent identities independent.
 * @test        tests/unit/browser-bridge.test.ts, tests/integration/browser-runtime-autostart.test.ts, tests/integration/browser-runtime-broker.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import { randomUUID } from "node:crypto";

import {
  createBrowserInvocationContext,
  type BrowserInvocationContext,
} from "./invocation-context.js";
import {
  createBrowserInvocationScope,
  currentBrowserInvocationScope,
  registerBrowserTurnParticipant,
  type BrowserInvocationScope,
  type BrowserProvider,
  type BrowserTurnFinalizerHandle,
} from "./invocation-scope.js";
import { ensureBrowserRuntimeBroker } from "./runtime-launch.js";
import {
  BROWSER_BROKER_DEFAULT_SESSION_TTL_MS,
  isBrowserAgentPresenceResult,
  type BrowserAgentPresenceResult,
  type BrowserBrokerStatus,
  type BrowserChromeTargetClaimRequest,
  type BrowserPageCommand,
  type BrowserSessionStartResult,
  type BrowserTargetCommandRequest,
  type BrowserTargetCommandResult,
} from "./runtime-protocol.js";
import type {
  ChromeContentSearchQuery,
  ChromeContentSearchResult,
  ChromeNativeTab,
  ChromeNativeTarget,
} from "./chrome-native-protocol.js";
import {
  BrowserBrokerClientError,
  BrowserBrokerOutcomeAmbiguousError,
  type BrowserRuntimeBrokerClient,
} from "./runtime-transport.js";
import type { BrowserSessionLeaseTarget } from "../engine/browser/session-lease.js";
import { writeFileTransactionally } from "../engine/transactional-file.js";
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
  private connectedOptions: BrowserBridgeConnectOptions | null = null;
  private state: "idle" | "connecting" | "connected" | "closed" = "idle";

  async connect(options: BrowserBridgeConnectOptions = {}): Promise<IPage> {
    if (this.state === "connected" && this.page) {
      if (
        !sameConnectOptions(this.connectedOptions ?? {}, options) ||
        !ambientScopeMatches(this.page.scope)
      ) {
        throw new BridgeConnectionError(
          "A connected BrowserBridge cannot change Agent identity, target provider, or profile policy",
        );
      }
      return this.page;
    }
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
    await page?.close();
    this.page = null;
    this.connectedOptions = null;
    this.state = "closed";
  }

  async discard(lifecycle: "turn" | "session" = "turn"): Promise<void> {
    if (this.state === "closed") return;
    const page = this.page ?? (this.connection ? await this.connection : null);
    try {
      await page?.discard(lifecycle);
    } finally {
      this.page = null;
      this.connectedOptions = null;
      this.state = "closed";
    }
  }

  private async open(
    scope: BrowserInvocationScope,
    options: BrowserBridgeConnectOptions,
  ): Promise<BrowserBrokerPage> {
    const { client } = await ensureBrowserRuntimeBroker({
      runtimeRoot: options.runtimeRoot,
      startupTimeoutMs: options.timeout,
    });
    const started = await client.requestOrThrow<BrowserSessionStartResult>(
      {
        id: randomUUID(),
        action: "session.start",
        context: scope.context,
      },
      scope.signal,
    );
    const sessionTtlMs =
      Number.isSafeInteger(started?.session_ttl_ms) &&
      started.session_ttl_ms >= 0
        ? started.session_ttl_ms
        : BROWSER_BROKER_DEFAULT_SESSION_TTL_MS;
    const page = new BrowserBrokerPage(client, scope, sessionTtlMs);
    this.page = page;
    this.connectedOptions = { ...options };
    this.state = "connected";
    let finalizer: BrowserTurnFinalizerHandle | undefined;
    try {
      finalizer = await registerBrowserTurnParticipant(
        turnKey(scope.context),
        () => page.prepareForTurnFinalization(),
        () =>
          client.requestOrThrow({
            id: randomUUID(),
            action: "turn.end",
            context: scope.context,
          }),
      );
    } catch (error) {
      await page.prepareForTurnFinalization();
      try {
        await client.requestOrThrow({
          id: randomUUID(),
          action: "turn.end",
          context: scope.context,
        });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Late browser turn connection and cleanup both failed",
        );
      }
      throw error;
    }
    page.bindTurnFinalizer(finalizer);
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
  responseBodyUnavailable?: { reason: string };
}

export class BrowserBrokerPage implements IPage {
  private targetId: string | undefined;
  private targetEvidence: BrowserSessionLeaseTarget | null = null;
  private lifecycleState: "open" | "ending" | "ended" = "open";
  private lifecycleRequest: Promise<void> | null = null;
  private readonly networkHistory: NetworkRequest[] = [];
  private readonly heartbeatIntervalMs: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatRequest: Promise<void> | null = null;
  private heartbeatController: AbortController | null = null;
  private heartbeatFailure: unknown;
  private turnFinalizer: BrowserTurnFinalizerHandle | undefined;

  constructor(
    private readonly client: BrowserRuntimeBrokerClient,
    readonly scope: BrowserInvocationScope,
    sessionTtlMs: number,
  ) {
    this.heartbeatIntervalMs =
      sessionTtlMs > 0 ? Math.max(1, Math.floor(sessionTtlMs / 3)) : 0;
    this.startHeartbeat();
  }

  async browserTargetInfo(): Promise<BrowserSessionLeaseTarget | null> {
    const target = this.browserTargetIdentity();
    if (!target) return null;
    const [url, title] = await Promise.all([this.url(), this.title()]);
    return {
      ...target,
      url,
      title,
    };
  }

  browserTargetIdentity(): BrowserSessionLeaseTarget | null {
    return this.targetEvidence ? { ...this.targetEvidence } : null;
  }

  async adoptPreparedTarget(): Promise<BrowserSessionLeaseTarget | null> {
    if (this.targetId) return this.browserTargetInfo();
    const status = await this.client.requestOrThrow<BrowserBrokerStatus>(
      { id: randomUUID(), action: "broker.status" },
      this.scope.signal,
    );
    const lease = status.sessions.target_leases.find(
      (candidate) =>
        candidate.owner_session_id === this.scope.context.agent_session_id &&
        candidate.provider === this.scope.provider &&
        candidate.visibility === this.scope.visibility &&
        candidate.profile_partition_id === this.scope.profilePartitionId,
    );
    if (!lease) return null;
    this.targetId = lease.target_id;
    this.targetEvidence = {
      kind: "broker-target",
      captured_at: new Date().toISOString(),
      target_id: lease.target_id,
      provider: lease.provider,
      visibility: lease.visibility,
      owned: lease.provider !== "chrome",
    };
    return this.browserTargetIdentity();
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

  evaluate(script: string, signal?: AbortSignal): Promise<unknown> {
    return this.command({ method: "evaluate", expression: script }, signal);
  }

  async wait(seconds: number): Promise<void> {
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new TypeError("Browser wait seconds must be a non-negative number");
    }
    this.assertHeartbeatHealthy();
    await delay(seconds * 1_000, this.scope.signal);
    this.assertHeartbeatHealthy();
  }

  async waitForSelector(selector: string, timeout = 10_000): Promise<void> {
    const deadline = Date.now() + timeout;
    const selectorJson = JSON.stringify(selector);
    while (Date.now() < deadline) {
      if (await this.evaluate(`!!document.querySelector(${selectorJson})`)) {
        return;
      }
      await delay(200, this.scope.signal);
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
      this.assertHeartbeatHealthy();
      await delay(condition, this.scope.signal);
      this.assertHeartbeatHealthy();
      return;
    }
    await this.waitForSelector(condition, timeout);
  }

  async click(selector: string): Promise<void> {
    await this.command({ method: "click", selector });
  }

  async clickRef(selector: string, snapshotId: string): Promise<void> {
    await this.command({ method: "click", selector, snapshot_id: snapshotId });
  }

  async type(selector: string, text: string): Promise<void> {
    await this.command({ method: "type", selector, text });
  }

  async typeWithMode(
    selector: string,
    text: string,
    mode: "insert_text" | "keystrokes",
    snapshotId?: string,
  ): Promise<void> {
    await this.command({
      method: "type",
      selector,
      text,
      mode,
      ...(snapshotId === undefined ? {} : { snapshot_id: snapshotId }),
    });
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
      await delay(waitMilliseconds, this.scope.signal);
    }
  }

  async nativeClick(x: number, y: number): Promise<void> {
    await this.command({ method: "native_click", x, y });
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

  async snapshot(
    options?: SnapshotOptions,
    signal?: AbortSignal,
  ): Promise<string> {
    const { snapshotWithFingerprint } = await import("./snapshot-helpers.js");
    return snapshotWithFingerprint(this, options, signal ?? this.scope.signal);
  }

  async screenshot(
    options?: ScreenshotOptions,
    signal: AbortSignal | undefined = this.scope.signal,
  ): Promise<Buffer> {
    const encoded = expectString(
      await this.command(
        {
          method: "screenshot",
          ...(options?.format ? { format: options.format } : {}),
          ...(options?.quality === undefined
            ? {}
            : { quality: options.quality }),
          ...(options?.fullPage === undefined
            ? {}
            : { full_page: options.fullPage }),
          ...(options?.clip ? { clip: options.clip } : {}),
        },
        signal,
      ),
      "screenshot",
    );
    const bytes = Buffer.from(encoded, "base64");
    if (options?.path) {
      await writeFileTransactionally(options.path, bytes, { signal });
    } else {
      signal?.throwIfAborted();
    }
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
      return this.client.requestOrThrow<ChromeNativeTab[]>(
        {
          id: randomUUID(),
          action: "chrome.tabs.list",
          context: this.scope.context,
        },
        this.scope.signal,
      );
    }
    if (!this.targetId) await this.url();
    const target = await this.browserTargetInfo();
    return target ? [target] : [];
  }

  async searchChromeContent(
    search: ChromeContentSearchQuery,
  ): Promise<ChromeContentSearchResult> {
    if (this.scope.provider !== "chrome") {
      throw new Error("Chrome content search requires the Chrome provider");
    }
    this.assertHeartbeatHealthy();
    return this.client.requestOrThrow<ChromeContentSearchResult>(
      {
        id: randomUUID(),
        action: "chrome.content.search",
        context: this.scope.context,
        search,
      },
      this.scope.signal,
    );
  }

  async setAgentPresence(
    visible: boolean,
    label?: string,
  ): Promise<BrowserAgentPresenceResult> {
    return expectAgentPresenceResult(
      await this.command({
        method: "agent_presence",
        visible,
        ...(label === undefined ? {} : { label }),
      }),
    );
  }

  async moveAgentCursor(
    x: number,
    y: number,
    visible = true,
  ): Promise<BrowserAgentPresenceResult> {
    return expectAgentPresenceResult(
      await this.command({ method: "agent_cursor", x, y, visible }),
    );
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
    const target = await this.client.requestOrThrow<ChromeNativeTarget>(
      request,
      this.scope.signal,
    );
    this.targetId = target.target_id;
    this.targetEvidence = {
      kind: "broker-target",
      captured_at: new Date().toISOString(),
      target_id: target.target_id,
      provider: "chrome",
      visibility: target.visibility,
      tab_id: target.tab_id,
      window_id: target.window_id,
      owned: target.owned,
      ...(target.url === undefined ? {} : { url: target.url }),
      ...(target.title === undefined ? {} : { title: target.title }),
    };
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
    if (this.turnFinalizer) return this.turnFinalizer.finalize();
    return this.finishLifecycle(() =>
      this.client.requestOrThrow({
        id: randomUUID(),
        action: "turn.end",
        context: this.scope.context,
      }),
    );
  }

  async closeWindow(): Promise<void> {
    if (this.turnFinalizer) {
      return this.turnFinalizer.finalize(() =>
        this.client.requestOrThrow({
          id: randomUUID(),
          action: "session.end",
          agent_session_id: this.scope.context.agent_session_id,
        }),
      );
    }
    return this.finishLifecycle(() =>
      this.client.requestOrThrow({
        id: randomUUID(),
        action: "session.end",
        agent_session_id: this.scope.context.agent_session_id,
      }),
    );
  }

  async discard(lifecycle: "turn" | "session" = "turn"): Promise<void> {
    if (this.lifecycleState === "ended") return;
    const errors: unknown[] = [];
    const targetId = this.targetId;
    if (targetId) {
      try {
        await this.client.requestOrThrow({
          id: randomUUID(),
          action: "target.discard",
          context: this.scope.context,
          target_id: targetId,
        });
        this.targetId = undefined;
        this.targetEvidence = null;
      } catch (error) {
        if (
          error instanceof BrowserBrokerClientError &&
          (error.code === "browser_target_discarded" ||
            error.code === "browser_target_unusable")
        ) {
          this.targetId = undefined;
          this.targetEvidence = null;
        } else {
          errors.push(error);
        }
      }
    }
    try {
      await (lifecycle === "session" ? this.closeWindow() : this.close());
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Browser target discard failed");
    }
  }

  private async command(
    command: BrowserPageCommand,
    signal: AbortSignal | undefined = this.scope.signal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    this.assertHeartbeatHealthy();
    if (this.lifecycleState !== "open") {
      throw new Error(
        `Browser turn ${this.scope.context.turn_id} has already ended`,
      );
    }
    let result: BrowserTargetCommandResult;
    try {
      result = await this.client.requestOrThrow<BrowserTargetCommandResult>(
        this.targetCommand(command),
        signal,
      );
    } catch (error) {
      if (this.targetId && commandFailureInvalidatesTarget(error)) {
        this.targetId = undefined;
        this.targetEvidence = null;
      }
      throw error;
    }
    this.targetId = result.target_id;
    const prior =
      this.targetEvidence?.target_id === result.target_id
        ? this.targetEvidence
        : undefined;
    this.targetEvidence = {
      kind: "broker-target",
      captured_at: new Date().toISOString(),
      target_id: result.target_id,
      provider: result.provider,
      visibility: result.visibility,
      owned: result.owned,
      ...(result.tab_id === undefined ? {} : { tab_id: result.tab_id }),
      ...(result.window_id === undefined
        ? {}
        : { window_id: result.window_id }),
      ...(prior?.url === undefined ? {} : { url: prior.url }),
      ...(prior?.title === undefined ? {} : { title: prior.title }),
    };
    return result.data;
  }

  private async finishLifecycle(
    request: () => Promise<unknown>,
  ): Promise<void> {
    if (this.lifecycleState === "ended") return;
    if (this.lifecycleRequest) return this.lifecycleRequest;
    this.lifecycleState = "ending";
    let lifecycleRequest!: Promise<void>;
    lifecycleRequest = (async () => {
      try {
        await this.stopHeartbeat();
        await request();
        this.lifecycleState = "ended";
      } catch (error) {
        this.lifecycleState = "open";
        if (!this.scope.signal?.aborted) this.startHeartbeat();
        throw error;
      } finally {
        if (this.lifecycleRequest === lifecycleRequest) {
          this.lifecycleRequest = null;
        }
      }
    })();
    this.lifecycleRequest = lifecycleRequest;
    return lifecycleRequest;
  }

  bindTurnFinalizer(finalizer: BrowserTurnFinalizerHandle | undefined): void {
    this.turnFinalizer = finalizer;
  }

  async prepareForTurnFinalization(): Promise<void> {
    if (this.lifecycleState === "ended") return;
    this.lifecycleState = "ending";
    try {
      await this.stopHeartbeat();
    } finally {
      this.lifecycleState = "ended";
    }
  }

  private startHeartbeat(): void {
    if (
      this.heartbeatIntervalMs === 0 ||
      this.heartbeatTimer ||
      this.lifecycleState !== "open"
    ) {
      return;
    }
    this.heartbeatTimer = setInterval(
      () => this.beginHeartbeat(),
      this.heartbeatIntervalMs,
    );
    this.heartbeatTimer.unref();
  }

  private beginHeartbeat(): void {
    if (this.lifecycleState !== "open" || this.heartbeatRequest) return;
    const controller = new AbortController();
    this.heartbeatController = controller;
    let heartbeat!: Promise<void>;
    heartbeat = this.client
      .requestOrThrow(
        {
          id: randomUUID(),
          action: "turn.touch",
          context: this.scope.context,
        },
        controller.signal,
      )
      .then(() => {
        this.heartbeatFailure = undefined;
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) this.heartbeatFailure = error;
      })
      .finally(() => {
        if (this.heartbeatRequest === heartbeat) this.heartbeatRequest = null;
        if (this.heartbeatController === controller) {
          this.heartbeatController = null;
        }
      });
    this.heartbeatRequest = heartbeat;
  }

  private async stopHeartbeat(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.heartbeatController?.abort(
      new Error("Browser turn heartbeat stopped"),
    );
    await this.heartbeatRequest;
  }

  private assertHeartbeatHealthy(): void {
    if (this.heartbeatFailure !== undefined) throw this.heartbeatFailure;
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

function commandFailureInvalidatesTarget(error: unknown): boolean {
  return (
    error instanceof BrowserBrokerOutcomeAmbiguousError ||
    (error instanceof BrowserBrokerClientError &&
      (error.code === "browser_target_discarded" ||
        error.code === "browser_target_unusable" ||
        error.code === "browser_command_outcome_ambiguous" ||
        (error.code === "browser_command_canceled" && !error.retryable)))
  );
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
    left.profile_partition_id === right.profile_partition_id &&
    left.upstream_turn_id === right.upstream_turn_id
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

function ambientScopeMatches(scope: BrowserInvocationScope): boolean {
  const ambient = currentBrowserInvocationScope();
  return ambient === undefined || sameScopeIdentity(scope, ambient);
}

function sameScopeIdentity(
  left: BrowserInvocationScope,
  right: BrowserInvocationScope,
): boolean {
  return (
    sameInvocationContext(left.context, right.context) &&
    left.provider === right.provider &&
    left.visibility === right.visibility &&
    left.profilePartitionId === right.profilePartitionId &&
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

function expectAgentPresenceResult(value: unknown): BrowserAgentPresenceResult {
  if (!isBrowserAgentPresenceResult(value)) {
    throw new TypeError("Browser agent presence returned invalid data");
  }
  return value as BrowserAgentPresenceResult;
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

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
  if (signal.aborted) return Promise.reject(browserAbortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(browserAbortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function browserAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Browser invocation aborted");
}
