/**
 * @owner       src/browser/page.ts
 * @does        Implement high-level navigation, DOM/input, storage, screenshot, snapshot, network-capture, and raw CDP operations for one page target.
 * @needs       src/browser/cdp-client.ts CDPCommandClient, key-descriptor.ts, ref-target.ts, snapshot-helpers.ts, src/types.ts, src/engine/browser/session-lease.ts, transactional file publication
 * @feeds       src/browser/bridge.ts, managed-browser.ts, browser helpers, pipeline browser steps
 * @breaks      Throws exact navigation, typed load-timeout, evaluation, selector, input, screenshot, and CDP errors from the bound target.
 * @invariants  One BrowserPage owns one root or flattened-session CDP command client; ref input uses the latest exact renderer registry and coordinate input must fit the live CSS viewport before trusted CDP dispatch; non-idempotent input is never replayed after dispatch; request cancellation reaches CDP waits, commands, and screenshot publication; navigation timeout is ambiguous rather than successful; DOM-settle and auto-scroll never hide target/transport loss; navigation listeners and timers are removed on load, timeout, error, or abort; close releases only that client's state.
 * @side-effects Navigates and mutates a browser target, dispatches input, captures network bodies and pixels, and opens/closes one CDP connection.
 * @perf        Direct CDP operations are O(1) round trips; selector polling and snapshots scale with page complexity.
 * @concurrency CDP request ids permit overlap; broker target queues serialize mutations, and network-capture drains serialize so one response is consumed by at most one reader.
 * @test        tests/unit/browser-page.test.ts, tests/integration/browser-runtime-isolation.test.ts
 * @stability   stable
 * @since       2026-04-04
 */

import {
  CDPClient,
  type CDPCommandClient,
  type ConnectToChromeOptions,
} from "./cdp-client.js";
import type { CDPTarget } from "./cdp-client.js";
import type {
  IPage,
  SnapshotOptions,
  ScreenshotOptions,
  NetworkRequest,
} from "../types.js";
import type { BrowserSessionLeaseTarget } from "../engine/browser/session-lease.js";
import { writeFileTransactionally } from "../engine/transactional-file.js";
import {
  BROWSER_VIEWPORT_EXPRESSION,
  buildBrowserRefTargetExpression,
  requireBrowserRefTarget,
  requireBrowserViewportPoint,
} from "./ref-target.js";
import { browserKeyEventPair } from "./key-descriptor.js";

// ── CDP result types ────────────────────────────────────────────────

interface RuntimeEvaluateResult {
  result?: { value?: unknown };
  exceptionDetails?: {
    exception?: { description?: string };
    text?: string;
  };
}

interface CookieEntry {
  name: string;
  value: string;
  domain: string;
}

interface GetCookiesResult {
  cookies?: CookieEntry[];
}

interface NavigateResult {
  frameId?: string;
  loaderId?: string;
  errorText?: string;
  isDownload?: boolean;
}

interface PageLifecycleEvent {
  frameId?: string;
  loaderId?: string;
  name?: string;
}

interface GetDocumentResult {
  root: { nodeId: number };
}

interface QuerySelectorResult {
  nodeId: number;
}

interface BoxModelResult {
  model: { content: number[] };
}

interface CaptureScreenshotResult {
  data: string;
}

interface NetworkResponseEvent {
  requestId: string;
  response: {
    url: string;
    status: number;
    mimeType?: string;
    headers?: Record<string, string>;
    remoteIPAddress?: string;
    remotePort?: number;
  };
  type?: string;
  timestamp?: number;
}

interface NetworkRequestWillBeSentEvent {
  requestId: string;
  request: {
    url: string;
    method: string;
  };
}

interface NetworkLoadingFinishedEvent {
  requestId: string;
  encodedDataLength?: number;
}

interface NetworkLoadingFailedEvent {
  requestId: string;
  errorText?: string;
  canceled?: boolean;
}

interface NetworkCaptureCompletion {
  promise: Promise<void>;
  resolve: () => void;
}

interface GetResponseBodyResult {
  body: string;
  base64Encoded: boolean;
}

/** Captured network response with body content */
export interface NetworkCaptureEntry {
  url: string;
  method: string;
  status: number;
  contentType: string;
  responseBody?: string;
  responseBodyUnavailable?: { reason: string };
  size: number;
  timestamp: number;
  remoteIPAddress?: string;
  remotePort?: number;
}

// ── Constants ───────────────────────────────────────────────────────

const DEFAULT_WAIT_TIMEOUT = 10_000;
const POLL_INTERVAL = 200;
const LOAD_EVENT_TIMEOUT = 30_000;
const NETWORK_CAPTURE_COMPLETION_TIMEOUT = 30_000;

function navigationLifecycleName(waitUntil?: string): string {
  return waitUntil === "domcontentloaded" ? "DOMContentLoaded" : "load";
}

export class BrowserNavigationTimeoutError extends Error {
  readonly code = "browser_navigation_timeout";
  readonly retryable = false;
  readonly outcome_ambiguous = true;
  readonly target_unusable = false;
  readonly suggestion =
    "Inspect the destination state before retrying; the navigation was dispatched but no matching document lifecycle event arrived.";

  constructor(url: string) {
    super(
      `Navigation to ${url} did not emit a matching Page.lifecycleEvent within ${String(LOAD_EVENT_TIMEOUT)}ms`,
    );
    this.name = "BrowserNavigationTimeoutError";
  }
}

function connectedTargetSnapshot(
  capturedAt: string,
  connectedTarget?: CDPTarget,
): BrowserSessionLeaseTarget | null {
  if (!connectedTarget) return null;
  return {
    kind: "cdp-target",
    captured_at: capturedAt,
    target_id: connectedTarget.id,
    target_type: connectedTarget.type,
  };
}

// ── BrowserPage ─────────────────────────────────────────────────────

export class BrowserPage implements IPage {
  private client: CDPCommandClient;
  private _networkEnabled = false;
  private _networkRequests: NetworkRequest[] = [];

  // Network body capture state
  private _networkCapture = new Map<string, NetworkCaptureEntry>();
  private _networkCaptureEnabled = false;
  private _networkCapturePattern?: string | RegExp;
  private _requestMethods = new Map<string, string>();
  private _networkCaptureCompletions = new Map<
    string,
    NetworkCaptureCompletion
  >();
  private _networkBodyErrors = new Map<string, unknown>();
  private _networkCaptureReadTail = Promise.resolve();

  constructor(client: CDPCommandClient) {
    this.client = client;
  }

  async browserTargetInfo(
    options: {
      authoritative?: boolean;
    } = {},
  ): Promise<BrowserSessionLeaseTarget | null> {
    const capturedAt = new Date().toISOString();
    const connectedTarget = this.client.getConnectedTarget();

    try {
      const raw = (await this.client.send("Target.getTargetInfo")) as {
        targetInfo?: {
          targetId?: string;
          type?: string;
          url?: string;
          title?: string;
        };
      };
      const info = raw.targetInfo;
      if (!info) {
        return options.authoritative
          ? null
          : connectedTargetSnapshot(capturedAt, connectedTarget);
      }
      return {
        kind: "cdp-target",
        captured_at: capturedAt,
        ...(info.targetId || connectedTarget?.id
          ? { target_id: info.targetId ?? connectedTarget?.id }
          : {}),
        ...(info.type || connectedTarget?.type
          ? { target_type: info.type ?? connectedTarget?.type }
          : {}),
        ...(info.url ? { url: info.url } : {}),
        ...(info.title ? { title: info.title } : {}),
      };
    } catch (error) {
      if (options.authoritative) throw error;
      return connectedTargetSnapshot(capturedAt, connectedTarget);
    }
  }

  /**
   * Navigate to a URL and wait for page load.
   */
  async goto(
    url: string,
    options?: { settleMs?: number; waitUntil?: string },
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    await this.client.send(
      "Page.setLifecycleEventsEnabled",
      { enabled: true },
      undefined,
      signal,
    );
    signal?.throwIfAborted();
    const waitUntil = navigationLifecycleName(options?.waitUntil);
    let expectedLoaderId: string | undefined;
    let expectedFrameId: string | undefined;
    const bufferedEvents: PageLifecycleEvent[] = [];
    let cancelLifecycleWait!: () => void;
    const lifecyclePromise = new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        this.client.off("Page.lifecycleEvent", handler);
        signal?.removeEventListener("abort", abortHandler);
        if (error) reject(error);
        else resolve();
      };
      const handler = (raw: unknown): void => {
        const event = raw as PageLifecycleEvent;
        if (event.name !== waitUntil) return;
        if (expectedLoaderId === undefined) {
          bufferedEvents.push(event);
          return;
        }
        if (
          event.loaderId === expectedLoaderId &&
          (expectedFrameId === undefined || event.frameId === expectedFrameId)
        ) {
          finish();
        }
      };
      const abortHandler = (): void => finish(signal?.reason);
      cancelLifecycleWait = () => finish();
      this.client.on("Page.lifecycleEvent", handler);
      signal?.addEventListener("abort", abortHandler, { once: true });
      timeout = setTimeout(
        () => finish(new BrowserNavigationTimeoutError(url)),
        LOAD_EVENT_TIMEOUT,
      );
    });
    lifecyclePromise.catch(() => undefined);

    try {
      const result = (await this.client.send(
        "Page.navigate",
        { url },
        undefined,
        signal,
      )) as NavigateResult;
      if (result.errorText) {
        throw new Error(`Navigation failed: ${result.errorText}`);
      }
      if (result.isDownload) {
        throw new Error(`Navigation failed: ${url} started a download`);
      }
      if (options?.waitUntil !== "commit" && result.loaderId) {
        expectedLoaderId = result.loaderId;
        expectedFrameId = result.frameId;
        if (
          bufferedEvents.some(
            (event) =>
              event.loaderId === expectedLoaderId &&
              (expectedFrameId === undefined ||
                event.frameId === expectedFrameId),
          )
        ) {
          cancelLifecycleWait();
        }
        await lifecyclePromise;
      }
    } finally {
      cancelLifecycleWait();
    }

    // DOM settle detection for JS-heavy pages (replaces simple setTimeout)
    const settleMs = options?.settleMs;
    if (settleMs && settleMs > 0) {
      const { waitForDomStableJs } = await import("./dom-helpers.js");
      try {
        await this.evaluate(
          waitForDomStableJs(settleMs, Math.min(settleMs, 500)),
          signal,
        );
      } catch (error) {
        signal?.throwIfAborted();
        if (!isPageEvaluationError(error)) throw error;
        await abortableDelay(settleMs, signal);
      }
    }
  }

  /**
   * Execute JavaScript in the page context and return the result.
   */
  async evaluate(expression: string, signal?: AbortSignal): Promise<unknown> {
    const result = (await this.client.send(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        allowUnsafeEvalBlockedByCSP: true,
      },
      undefined,
      signal,
    )) as RuntimeEvaluateResult;

    if (result.exceptionDetails) {
      const description =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "Unknown evaluation error";
      throw new Error(`Evaluate error: ${description}`);
    }

    return result.result?.value;
  }

  /** Click an element through the trusted CDP Input route. */
  async click(
    selector: string,
    signal?: AbortSignal,
    expectedSnapshotId?: string,
  ): Promise<void> {
    let cx: number;
    let cy: number;
    const refExpression = buildBrowserRefTargetExpression(
      selector,
      expectedSnapshotId,
    );
    if (expectedSnapshotId !== undefined && !refExpression) {
      throw new TypeError("A snapshot id requires a ref-bearing selector");
    }
    if (refExpression) {
      const target = requireBrowserRefTarget(
        await this.evaluate(refExpression, signal),
      );
      cx = target.x;
      cy = target.y;
    } else {
      const docResult = (await this.client.send(
        "DOM.getDocument",
        undefined,
        undefined,
        signal,
      )) as GetDocumentResult;
      const queryResult = (await this.client.send(
        "DOM.querySelector",
        {
          nodeId: docResult.root.nodeId,
          selector,
        },
        undefined,
        signal,
      )) as QuerySelectorResult;

      if (queryResult.nodeId === 0) {
        throw new Error("Element not found");
      }

      const boxResult = (await this.client.send(
        "DOM.getBoxModel",
        { nodeId: queryResult.nodeId },
        undefined,
        signal,
      )) as BoxModelResult;

      const content = boxResult.model.content;
      cx = (content[0] + content[2] + content[4] + content[6]) / 4;
      cy = (content[1] + content[3] + content[5] + content[7]) / 4;
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
        throw new Error("Element box model is invalid");
      }
    }
    await dispatchInputPair(
      this.client,
      "Input.dispatchMouseEvent",
      {
        type: "mousePressed",
        x: cx,
        y: cy,
        button: "left",
        clickCount: 1,
      },
      {
        type: "mouseReleased",
        x: cx,
        y: cy,
        button: "left",
        clickCount: 1,
      },
      signal,
    );
  }

  /**
   * Type text into a specific element (focuses it first via click).
   */
  async type(
    selector: string,
    text: string,
    signal?: AbortSignal,
    mode: "insert_text" | "keystrokes" = "insert_text",
    expectedSnapshotId?: string,
  ): Promise<void> {
    await this.click(selector, signal, expectedSnapshotId);
    if (mode === "insert_text") {
      await this.client.send("Input.insertText", { text }, undefined, signal);
      return;
    }
    for (const character of text) {
      const key = character === "\n" ? "Enter" : character;
      const keyText = character === "\n" ? "\r" : character;
      await dispatchInputPair(
        this.client,
        "Input.dispatchKeyEvent",
        { type: "keyDown", key, text: keyText },
        { type: "keyUp", key },
        signal,
      );
    }
  }

  /**
   * Press a keyboard key, optionally with modifier keys.
   */
  async press(
    key: string,
    modifiers?: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const events = browserKeyEventPair(key, modifiers);

    await dispatchInputPair(
      this.client,
      "Input.dispatchKeyEvent",
      events.down,
      events.up,
      signal,
    );
  }

  /**
   * Wait for a fixed number of seconds.
   */
  async wait(seconds: number, signal?: AbortSignal): Promise<void> {
    await abortableDelay(seconds * 1000, signal);
  }

  /**
   * Wait for a CSS selector to appear in the DOM.
   */
  async waitForSelector(
    selector: string,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const maxWait = timeout ?? DEFAULT_WAIT_TIMEOUT;
    const deadline = Date.now() + maxWait;
    const selectorJson = JSON.stringify(selector);

    while (Date.now() < deadline) {
      const found = await this.evaluate(
        `!!document.querySelector(${selectorJson})`,
        signal,
      );
      if (found) return;
      await abortableDelay(POLL_INTERVAL, signal);
    }

    throw new Error(
      `waitForSelector timed out after ${String(maxWait)}ms: ${selector}`,
    );
  }

  /**
   * Get all cookies for the current page, returned as name-value pairs.
   */
  async cookies(signal?: AbortSignal): Promise<Record<string, string>> {
    const result = (await this.client.send(
      "Network.getCookies",
      undefined,
      undefined,
      signal,
    )) as GetCookiesResult;
    const entries = result.cookies ?? [];
    const out: Record<string, string> = {};
    for (const c of entries) {
      out[c.name] = c.value;
    }
    return out;
  }

  /**
   * Get page title.
   */
  async title(signal?: AbortSignal): Promise<string> {
    return (await this.evaluate("document.title", signal)) as string;
  }

  /**
   * Get current URL.
   */
  async url(signal?: AbortSignal): Promise<string> {
    return (await this.evaluate("window.location.href", signal)) as string;
  }

  /**
   * Inject a script to evaluate on every new document.
   */
  async addInitScript(source: string, signal?: AbortSignal): Promise<void> {
    await this.client.send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source },
      undefined,
      signal,
    );
  }

  /**
   * Scroll the page in a direction.
   */
  async scroll(
    direction: "down" | "up" | "bottom" | "top" = "down",
    signal?: AbortSignal,
  ): Promise<void> {
    const scripts: Record<string, string> = {
      down: "window.scrollBy(0, window.innerHeight)",
      up: "window.scrollBy(0, -window.innerHeight)",
      bottom: "window.scrollTo(0, document.body.scrollHeight)",
      top: "window.scrollTo(0, 0)",
    };
    await this.evaluate(scripts[direction], signal);
  }

  /**
   * Polymorphic wait: milliseconds (number) or CSS selector (string).
   */
  async waitFor(
    condition: number | string,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (typeof condition === "number") {
      await abortableDelay(condition, signal);
    } else {
      await this.waitForSelector(condition, timeout, signal);
    }
  }

  /**
   * Insert text directly via CDP Input.insertText.
   * Bypasses controlled input handling (React, Vue, etc.).
   */
  async insertText(text: string, signal?: AbortSignal): Promise<void> {
    await this.client.send("Input.insertText", { text }, undefined, signal);
  }

  /**
   * Coordinate-based native click via CDP mouse events.
   */
  async nativeClick(x: number, y: number, signal?: AbortSignal): Promise<void> {
    requireBrowserViewportPoint(
      await this.evaluate(BROWSER_VIEWPORT_EXPRESSION, signal),
      x,
      y,
    );
    await dispatchInputPair(
      this.client,
      "Input.dispatchMouseEvent",
      {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      },
      {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      },
      signal,
    );
  }

  /**
   * Native key press with optional modifiers via CDP.
   */
  async nativeKeyPress(
    key: string,
    modifiers?: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const events = browserKeyEventPair(key, modifiers);

    await dispatchInputPair(
      this.client,
      "Input.dispatchKeyEvent",
      events.down,
      events.up,
      signal,
    );
  }

  /**
   * Upload files to a file input element via CDP.
   */
  async setFileInput(
    selector: string,
    files: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const docResult = (await this.client.send(
      "DOM.getDocument",
      undefined,
      undefined,
      signal,
    )) as GetDocumentResult;
    const queryResult = (await this.client.send(
      "DOM.querySelector",
      {
        nodeId: docResult.root.nodeId,
        selector,
      },
      undefined,
      signal,
    )) as QuerySelectorResult;

    if (queryResult.nodeId === 0) {
      throw new Error(`setFileInput: element not found: ${selector}`);
    }

    await this.client.send(
      "DOM.setFileInputFiles",
      { nodeId: queryResult.nodeId, files },
      undefined,
      signal,
    );
  }

  /**
   * Automatically scroll to the bottom of the page.
   * Useful for infinite-scroll pages.
   */
  async autoScroll(
    opts?: { maxScrolls?: number; delay?: number },
    signal?: AbortSignal,
  ): Promise<void> {
    const maxScrolls = opts?.maxScrolls ?? 20;
    const delay = opts?.delay ?? 1000;

    for (let i = 0; i < maxScrolls; i++) {
      await this.evaluate("window.scrollBy(0, window.innerHeight)", signal);
      await abortableDelay(delay, signal);

      const atBottom = (await this.evaluate(
        "(window.scrollY + window.innerHeight) >= (document.documentElement.scrollHeight - 50)",
        signal,
      )) as boolean;

      if (atBottom) break;
    }
  }

  /**
   * Capture a screenshot of the page.
   */
  async screenshot(
    opts?: ScreenshotOptions,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const format = opts?.format ?? "png";
    const params: Record<string, unknown> = { format };

    if (opts?.quality !== undefined && format !== "png") {
      params.quality = opts.quality;
    }

    if (opts?.fullPage) {
      // Get full page dimensions
      const dims = (await this.evaluate(
        "JSON.stringify({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })",
        signal,
      )) as string;
      let width: number, height: number;
      try {
        ({ width, height } = JSON.parse(dims) as {
          width: number;
          height: number;
        });
      } catch {
        throw new Error(
          `screenshot: failed to read page dimensions: ${String(dims)}`,
        );
      }
      params.clip = { x: 0, y: 0, width, height, scale: 1 };
    } else if (opts?.clip) {
      params.clip = { ...opts.clip, scale: 1 };
    }

    const result = (await this.client.send(
      "Page.captureScreenshot",
      params,
      undefined,
      signal,
    )) as CaptureScreenshotResult;

    const buffer = Buffer.from(result.data, "base64");

    if (opts?.path) {
      await writeFileTransactionally(opts.path, buffer, { signal });
    } else {
      signal?.throwIfAborted();
    }

    return buffer;
  }

  /**
   * Collect network requests. Enables Network domain on first call
   * and accumulates responses from that point on.
   */
  async networkRequests(signal?: AbortSignal): Promise<NetworkRequest[]> {
    signal?.throwIfAborted();
    if (!this._networkEnabled) {
      await this.client.send("Network.enable", undefined, undefined, signal);
      this._networkEnabled = true;

      this.client.on("Network.responseReceived", (params: unknown): void => {
        const event = params as NetworkResponseEvent;
        const resp = event.response;
        const contentLength =
          resp.headers?.["content-length"] ?? resp.headers?.["Content-Length"];
        this._networkRequests.push({
          url: resp.url,
          method: "GET", // CDP responseReceived doesn't include request method directly
          status: resp.status,
          type: event.type ?? resp.mimeType ?? "unknown",
          size: contentLength ? parseInt(contentLength, 10) : 0,
          timestamp: event.timestamp ?? Date.now(),
          ...(resp.remoteIPAddress
            ? { remoteIPAddress: resp.remoteIPAddress }
            : {}),
          ...(resp.remotePort !== undefined
            ? { remotePort: resp.remotePort }
            : {}),
        });
        // Cap buffer to prevent unbounded memory growth
        if (this._networkRequests.length > 500) {
          this._networkRequests.shift();
        }
      });
    }

    signal?.throwIfAborted();
    return [...this._networkRequests];
  }

  /**
   * Start capturing network responses with body content.
   * Optionally filter by URL pattern (substring match or /regex/).
   *
   * Unlike networkRequests() which only captures metadata, this method
   * also fetches the response body via Network.getResponseBody.
   *
   * Captured entries are read and drained via readNetworkCapture().
   */
  async startNetworkCapture(
    pattern?: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (this._networkCaptureEnabled) return true;

    // Enable Network domain if not already
    if (!this._networkEnabled) {
      await this.client.send("Network.enable", undefined, undefined, signal);
      this._networkEnabled = true;
    }

    // Parse pattern: string → substring match, /pattern/ → RegExp
    if (pattern) {
      const regexMatch = /^\/(.+)\/([gimsuy]*)$/.exec(pattern);
      if (regexMatch) {
        // Strip 'g' flag — stateful lastIndex causes intermittent misses with .test()
        const flags = regexMatch[2].replace(/g/g, "");
        this._networkCapturePattern = new RegExp(regexMatch[1], flags);
      } else {
        this._networkCapturePattern = pattern;
      }
    }

    this._networkCaptureEnabled = true;

    // Track request methods from requestWillBeSent
    this.client.on("Network.requestWillBeSent", (params: unknown): void => {
      const event = params as NetworkRequestWillBeSentEvent;
      this._requestMethods.set(event.requestId, event.request.method);
      // Cap method map to prevent unbounded growth
      if (this._requestMethods.size > 1000) {
        const firstKey = this._requestMethods.keys().next().value;
        if (firstKey !== undefined) this._requestMethods.delete(firstKey);
      }
    });

    // Store pending entries on responseReceived (metadata only)
    this.client.on("Network.responseReceived", (params: unknown): void => {
      if (!this._networkCaptureEnabled) return;
      const event = params as NetworkResponseEvent;
      const url = event.response.url;

      // Apply URL filter
      if (this._networkCapturePattern) {
        if (typeof this._networkCapturePattern === "string") {
          if (!url.includes(this._networkCapturePattern)) return;
        } else {
          if (!this._networkCapturePattern.test(url)) return;
        }
      }

      const contentType = event.response.mimeType ?? "unknown";
      const contentLength =
        event.response.headers?.["content-length"] ??
        event.response.headers?.["Content-Length"];
      const method = this._requestMethods.get(event.requestId) ?? "GET";

      this._networkCaptureCompletions.get(event.requestId)?.resolve();
      let resolveCompletion!: () => void;
      const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });
      this._networkCaptureCompletions.set(event.requestId, {
        promise: completion,
        resolve: resolveCompletion,
      });

      this._networkCapture.set(event.requestId, {
        url,
        method,
        status: event.response.status,
        contentType,
        size: contentLength ? parseInt(contentLength, 10) : 0,
        timestamp: event.timestamp ?? Date.now(),
        ...(event.response.remoteIPAddress
          ? { remoteIPAddress: event.response.remoteIPAddress }
          : {}),
        ...(event.response.remotePort !== undefined
          ? { remotePort: event.response.remotePort }
          : {}),
      });

      // Cap buffer at 100 entries
      if (this._networkCapture.size > 100) {
        const firstKey = this._networkCapture.keys().next().value;
        if (firstKey !== undefined) {
          this._networkCapture.delete(firstKey);
          this._networkCaptureCompletions.get(firstKey)?.resolve();
          this._networkCaptureCompletions.delete(firstKey);
          this._networkBodyErrors.delete(firstKey);
        }
      }
    });

    // Fetch body on loadingFinished
    this.client.on("Network.loadingFinished", (params: unknown): void => {
      if (!this._networkCaptureEnabled) return;
      const event = params as NetworkLoadingFinishedEvent;
      const entry = this._networkCapture.get(event.requestId);
      if (!entry) return;
      const completion = this._networkCaptureCompletions.get(event.requestId);

      // Update size from encodedDataLength if available
      if (
        event.encodedDataLength !== undefined &&
        event.encodedDataLength > 0
      ) {
        entry.size = event.encodedDataLength;
      }

      const bodyFetch = this.client
        .send("Network.getResponseBody", { requestId: event.requestId })
        .then((result: unknown) => {
          const body = result as GetResponseBodyResult;
          if (typeof body.body !== "string") {
            throw new Error("CDP returned no response body");
          }
          entry.responseBody = body.base64Encoded
            ? Buffer.from(body.body, "base64").toString("utf-8")
            : body.body;
        })
        .catch((error: unknown) => {
          if (isTargetTransportFailure(error)) {
            this._networkBodyErrors.set(event.requestId, error);
            throw error;
          }
          entry.responseBodyUnavailable = { reason: errorMessage(error) };
        })
        .finally(() => {
          completion?.resolve();
        });
      bodyFetch.catch(() => undefined);
    });

    this.client.on("Network.loadingFailed", (params: unknown): void => {
      if (!this._networkCaptureEnabled) return;
      const event = params as NetworkLoadingFailedEvent;
      const entry = this._networkCapture.get(event.requestId);
      if (!entry) return;
      entry.responseBodyUnavailable = {
        reason: event.canceled
          ? "Network request was canceled before a response body completed"
          : (event.errorText ??
            "Network request failed before a response body completed"),
      };
      this._networkCaptureCompletions.get(event.requestId)?.resolve();
    });

    return true;
  }

  /**
   * Read all captured network entries and clear the buffer.
   * Call startNetworkCapture() first to begin capturing.
   */
  async readNetworkCapture(
    signal?: AbortSignal,
  ): Promise<NetworkCaptureEntry[]> {
    const read = this._networkCaptureReadTail.then(() =>
      this.drainNetworkCapture(signal),
    );
    this._networkCaptureReadTail = read.then(
      () => undefined,
      () => undefined,
    );
    return awaitWithSignal(read, signal);
  }

  private async drainNetworkCapture(
    signal?: AbortSignal,
  ): Promise<NetworkCaptureEntry[]> {
    signal?.throwIfAborted();
    const captured = [...this._networkCapture.entries()];
    await Promise.all(
      captured.map(([requestId, entry]) =>
        this.waitForNetworkCaptureCompletion(requestId, entry, signal),
      ),
    );
    for (const [requestId] of captured) {
      const error = this._networkBodyErrors.get(requestId);
      if (error !== undefined) throw error;
    }
    for (const [requestId, entry] of captured) {
      if (this._networkCapture.get(requestId) === entry) {
        this._networkCapture.delete(requestId);
        this._networkCaptureCompletions.delete(requestId);
        this._networkBodyErrors.delete(requestId);
      }
    }
    return structuredClone(captured.map(([, entry]) => entry));
  }

  private async waitForNetworkCaptureCompletion(
    requestId: string,
    entry: NetworkCaptureEntry,
    signal?: AbortSignal,
  ): Promise<void> {
    const completion = this._networkCaptureCompletions.get(requestId);
    if (!completion) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const completionTimeout = new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        if (
          this._networkCapture.get(requestId) === entry &&
          entry.responseBody === undefined &&
          entry.responseBodyUnavailable === undefined
        ) {
          entry.responseBodyUnavailable = {
            reason: `Network response did not finish within ${String(NETWORK_CAPTURE_COMPLETION_TIMEOUT)}ms`,
          };
        }
        resolve();
      }, NETWORK_CAPTURE_COMPLETION_TIMEOUT);
      timeout.unref();
    });
    try {
      await awaitWithSignal(
        Promise.race([completion.promise, completionTimeout]),
        signal,
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  /**
   * Generate a DOM snapshot (accessibility-style text tree).
   * Interactive elements are annotated with [N] refs.
   * Also persists the fingerprint map so subsequent click/type calls
   * (pipeline or interactive `unicli operate`) can verify refs.
   */
  async snapshot(
    opts?: SnapshotOptions,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    const { snapshotWithFingerprint } = await import("./snapshot-helpers.js");
    return snapshotWithFingerprint(this, opts, signal);
  }

  /**
   * Raw CDP command passthrough for stealth injection etc.
   */
  async sendCDP(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.client.send(method, params, sessionId, signal);
  }

  /**
   * Close/disconnect from the page.
   */
  async close(): Promise<void> {
    await this.client.close();
  }

  /**
   * Close the entire browser window. Best-effort -- browser may already be gone.
   */
  async closeWindow(): Promise<void> {
    try {
      await this.client.send("Browser.close");
    } catch {
      // Browser may already be closed -- this is expected
    }
    // Clean up client listeners and pending state to avoid memory leaks
    await this.close();
  }

  /**
   * Static convenience: connect to Chrome and return a BrowserPage.
   */
  static async connect(
    port?: number,
    options?: ConnectToChromeOptions,
  ): Promise<BrowserPage> {
    const client = await CDPClient.connectToChrome(port, options);
    return new BrowserPage(client);
  }
}

function isPageEvaluationError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Evaluate error:");
}

function isTargetTransportFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; target_unusable?: unknown };
  if (candidate.target_unusable === true) return true;
  if (
    candidate.code === "cdp_connection_lost" ||
    candidate.code === "cdp_connection_not_open" ||
    candidate.code === "cdp_command_send_failed"
  ) {
    return true;
  }
  return (
    error instanceof Error &&
    /CDP (?:target )?connection (?:closed|lost)/i.test(error.message)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function awaitWithSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function dispatchInputPair(
  client: CDPCommandClient,
  method: string,
  pressParams: Record<string, unknown>,
  releaseParams: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const errors: unknown[] = [];
  try {
    await client.send(method, pressParams, undefined, signal);
  } catch (error) {
    errors.push(error);
  }
  try {
    await client.send(method, releaseParams);
  } catch (error) {
    errors.push(error);
  }
  if (signal?.aborted && !errors.includes(signal.reason)) {
    errors.unshift(signal.reason);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, `Paired ${method} dispatch failed`);
  }
}

function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
