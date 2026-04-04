/**
 * Browser page abstraction -- implements IPage interface via CDP.
 *
 * Provides high-level operations (goto, evaluate, click, type, cookies)
 * on top of the raw CDPClient WebSocket connection.
 */

import { CDPClient } from "./cdp-client.js";
import type {
  IPage,
  SnapshotOptions,
  ScreenshotOptions,
  NetworkRequest,
} from "../types.js";

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
  errorText?: string;
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
  response: {
    url: string;
    status: number;
    mimeType?: string;
    headers?: Record<string, string>;
  };
  type?: string;
  timestamp?: number;
}

// ── Key mapping ─────────────────────────────────────────────────────

const KEY_MAP: Record<string, { key: string; code: string; keyCode: number }> =
  {
    Enter: { key: "Enter", code: "Enter", keyCode: 13 },
    Tab: { key: "Tab", code: "Tab", keyCode: 9 },
    Escape: { key: "Escape", code: "Escape", keyCode: 27 },
    Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
    Delete: { key: "Delete", code: "Delete", keyCode: 46 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    Space: { key: " ", code: "Space", keyCode: 32 },
    Home: { key: "Home", code: "Home", keyCode: 36 },
    End: { key: "End", code: "End", keyCode: 35 },
    PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
    PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  };

// ── Modifier bitmask ────────────────────────────────────────────────

const MODIFIER_MAP: Record<string, number> = {
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  command: 4,
  shift: 8,
};

function computeModifiers(modifiers?: string[]): number {
  if (!modifiers || modifiers.length === 0) return 0;
  let mask = 0;
  for (const m of modifiers) {
    mask |= MODIFIER_MAP[m.toLowerCase()] ?? 0;
  }
  return mask;
}

// ── Constants ───────────────────────────────────────────────────────

const DEFAULT_WAIT_TIMEOUT = 10_000;
const POLL_INTERVAL = 200;
const LOAD_EVENT_TIMEOUT = 30_000;

// ── BrowserPage ─────────────────────────────────────────────────────

export class BrowserPage implements IPage {
  private client: CDPClient;
  private _networkEnabled = false;
  private _networkRequests: NetworkRequest[] = [];

  constructor(client: CDPClient) {
    this.client = client;
  }

  /**
   * Navigate to a URL and wait for page load.
   */
  async goto(
    url: string,
    options?: { settleMs?: number; waitUntil?: string },
  ): Promise<void> {
    // Set up a load event listener before navigating
    const loadPromise = new Promise<void>((resolve) => {
      const handler = (): void => {
        this.client.off("Page.loadEventFired", handler);
        resolve();
      };
      this.client.on("Page.loadEventFired", handler);

      // Timeout: resolve anyway after LOAD_EVENT_TIMEOUT so we don't hang
      setTimeout(() => {
        this.client.off("Page.loadEventFired", handler);
        resolve();
      }, LOAD_EVENT_TIMEOUT);
    });

    const result = (await this.client.send("Page.navigate", {
      url,
    })) as NavigateResult;
    if (result.errorText) {
      throw new Error(`Navigation failed: ${result.errorText}`);
    }

    await loadPromise;

    // Optional settle delay for JS-heavy pages
    const settleMs = options?.settleMs;
    if (settleMs && settleMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, settleMs));
    }
  }

  /**
   * Execute JavaScript in the page context and return the result.
   */
  async evaluate(expression: string): Promise<unknown> {
    const result = (await this.client.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      allowUnsafeEvalBlockedByCSP: true,
    })) as RuntimeEvaluateResult;

    if (result.exceptionDetails) {
      const description =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "Unknown evaluation error";
      throw new Error(`Evaluate error: ${description}`);
    }

    return result.result?.value;
  }

  /**
   * Click an element by CSS selector.
   * Attempts CDP DOM-based click first, falls back to JS click.
   */
  async click(selector: string): Promise<void> {
    try {
      // Try DOM-based click via CDP
      const docResult = (await this.client.send(
        "DOM.getDocument",
      )) as GetDocumentResult;
      const queryResult = (await this.client.send("DOM.querySelector", {
        nodeId: docResult.root.nodeId,
        selector,
      })) as QuerySelectorResult;

      if (queryResult.nodeId === 0) {
        throw new Error("Element not found");
      }

      const boxResult = (await this.client.send("DOM.getBoxModel", {
        nodeId: queryResult.nodeId,
      })) as BoxModelResult;

      const content = boxResult.model.content;
      // content is [x1,y1, x2,y2, x3,y3, x4,y4] -- compute center
      const cx = (content[0] + content[2] + content[4] + content[6]) / 4;
      const cy = (content[1] + content[3] + content[5] + content[7]) / 4;

      await this.client.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: cx,
        y: cy,
        button: "left",
        clickCount: 1,
      });
      await this.client.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: cx,
        y: cy,
        button: "left",
        clickCount: 1,
      });
    } catch {
      // Fallback: JS click
      const escaped = selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      await this.evaluate(
        `(() => { const el = document.querySelector('${escaped}'); if (!el) throw new Error('Element not found: ${escaped}'); el.click(); })()`,
      );
    }
  }

  /**
   * Type text into a specific element (focuses it first via click).
   */
  async type(selector: string, text: string): Promise<void> {
    // Focus the element first
    await this.click(selector);
    // Insert text via CDP
    await this.client.send("Input.insertText", { text });
  }

  /**
   * Press a keyboard key, optionally with modifier keys.
   */
  async press(key: string, modifiers?: string[]): Promise<void> {
    const mapped = KEY_MAP[key];
    const keyValue = mapped?.key ?? key;
    const code = mapped?.code ?? key;
    const keyCode = mapped?.keyCode ?? 0;
    const mod = computeModifiers(modifiers);

    const baseParams: Record<string, unknown> = {
      key: keyValue,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    };
    if (mod) {
      baseParams.modifiers = mod;
    }

    await this.client.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      ...baseParams,
    });
    await this.client.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      ...baseParams,
    });
  }

  /**
   * Wait for a fixed number of seconds.
   */
  async wait(seconds: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));
  }

  /**
   * Wait for a CSS selector to appear in the DOM.
   */
  async waitForSelector(selector: string, timeout?: number): Promise<void> {
    const maxWait = timeout ?? DEFAULT_WAIT_TIMEOUT;
    const deadline = Date.now() + maxWait;
    const escaped = selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

    while (Date.now() < deadline) {
      const found = await this.evaluate(
        `!!document.querySelector('${escaped}')`,
      );
      if (found) return;
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }

    throw new Error(
      `waitForSelector timed out after ${String(maxWait)}ms: ${selector}`,
    );
  }

  /**
   * Get all cookies for the current page, returned as name-value pairs.
   */
  async cookies(): Promise<Record<string, string>> {
    const result = (await this.client.send(
      "Network.getCookies",
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
  async title(): Promise<string> {
    return (await this.evaluate("document.title")) as string;
  }

  /**
   * Get current URL.
   */
  async url(): Promise<string> {
    return (await this.evaluate("window.location.href")) as string;
  }

  /**
   * Inject a script to evaluate on every new document.
   */
  async addInitScript(source: string): Promise<void> {
    await this.client.send("Page.addScriptToEvaluateOnNewDocument", {
      source,
    });
  }

  /**
   * Scroll the page in a direction.
   */
  async scroll(
    direction: "down" | "up" | "bottom" | "top" = "down",
  ): Promise<void> {
    const scripts: Record<string, string> = {
      down: "window.scrollBy(0, window.innerHeight)",
      up: "window.scrollBy(0, -window.innerHeight)",
      bottom: "window.scrollTo(0, document.body.scrollHeight)",
      top: "window.scrollTo(0, 0)",
    };
    await this.evaluate(scripts[direction]);
  }

  /**
   * Polymorphic wait: milliseconds (number) or CSS selector (string).
   */
  async waitFor(condition: number | string, timeout?: number): Promise<void> {
    if (typeof condition === "number") {
      await new Promise<void>((resolve) => setTimeout(resolve, condition));
    } else {
      await this.waitForSelector(condition, timeout);
    }
  }

  /**
   * Insert text directly via CDP Input.insertText.
   * Bypasses controlled input handling (React, Vue, etc.).
   */
  async insertText(text: string): Promise<void> {
    await this.client.send("Input.insertText", { text });
  }

  /**
   * Coordinate-based native click via CDP mouse events.
   */
  async nativeClick(x: number, y: number): Promise<void> {
    await this.client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await this.client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }

  /**
   * Native key press with optional modifiers via CDP.
   */
  async nativeKeyPress(key: string, modifiers?: string[]): Promise<void> {
    const mapped = KEY_MAP[key];
    const keyValue = mapped?.key ?? key;
    const code = mapped?.code ?? key;
    const keyCode =
      mapped?.keyCode ?? (key.length === 1 ? key.charCodeAt(0) : 0);
    const mod = computeModifiers(modifiers);

    const baseParams: Record<string, unknown> = {
      key: keyValue,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    };
    if (mod) {
      baseParams.modifiers = mod;
    }
    // For single characters, include text for character input
    if (key.length === 1 && !mod) {
      baseParams.text = key;
    }

    await this.client.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      ...baseParams,
    });
    await this.client.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      ...baseParams,
    });
  }

  /**
   * Upload files to a file input element via CDP.
   */
  async setFileInput(selector: string, files: string[]): Promise<void> {
    const docResult = (await this.client.send(
      "DOM.getDocument",
    )) as GetDocumentResult;
    const queryResult = (await this.client.send("DOM.querySelector", {
      nodeId: docResult.root.nodeId,
      selector,
    })) as QuerySelectorResult;

    if (queryResult.nodeId === 0) {
      throw new Error(`setFileInput: element not found: ${selector}`);
    }

    await this.client.send("DOM.setFileInputFiles", {
      nodeId: queryResult.nodeId,
      files,
    });
  }

  /**
   * Automatically scroll to the bottom of the page.
   * Useful for infinite-scroll pages.
   */
  async autoScroll(opts?: {
    maxScrolls?: number;
    delay?: number;
  }): Promise<void> {
    const maxScrolls = opts?.maxScrolls ?? 20;
    const delay = opts?.delay ?? 1000;

    for (let i = 0; i < maxScrolls; i++) {
      await this.evaluate("window.scrollBy(0, window.innerHeight)");
      await new Promise<void>((resolve) => setTimeout(resolve, delay));

      const atBottom = (await this.evaluate(
        "(window.scrollY + window.innerHeight) >= (document.documentElement.scrollHeight - 50)",
      )) as boolean;

      if (atBottom) break;
    }
  }

  /**
   * Capture a screenshot of the page.
   */
  async screenshot(opts?: ScreenshotOptions): Promise<Buffer> {
    const format = opts?.format ?? "png";
    const params: Record<string, unknown> = { format };

    if (opts?.quality !== undefined && format !== "png") {
      params.quality = opts.quality;
    }

    if (opts?.fullPage) {
      // Get full page dimensions
      const dims = (await this.evaluate(
        "JSON.stringify({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })",
      )) as string;
      const { width, height } = JSON.parse(dims) as {
        width: number;
        height: number;
      };
      params.clip = { x: 0, y: 0, width, height, scale: 1 };
    } else if (opts?.clip) {
      params.clip = { ...opts.clip, scale: 1 };
    }

    const result = (await this.client.send(
      "Page.captureScreenshot",
      params,
    )) as CaptureScreenshotResult;

    const buffer = Buffer.from(result.data, "base64");

    if (opts?.path) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(opts.path, buffer);
    }

    return buffer;
  }

  /**
   * Collect network requests. Enables Network domain on first call
   * and accumulates responses from that point on.
   */
  async networkRequests(): Promise<NetworkRequest[]> {
    if (!this._networkEnabled) {
      await this.client.send("Network.enable");
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
        });
      });
    }

    return [...this._networkRequests];
  }

  /**
   * Generate a DOM snapshot (accessibility-style text tree).
   * Interactive elements are annotated with [N] refs.
   */
  async snapshot(opts?: SnapshotOptions): Promise<string> {
    const { generateSnapshotJs } = await import("./snapshot.js");
    const js = generateSnapshotJs(opts);
    const result = await this.evaluate(js);
    return (result as string) ?? "";
  }

  /**
   * Raw CDP command passthrough for stealth injection etc.
   */
  async sendCDP(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    return this.client.send(method, params);
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
  static async connect(port?: number): Promise<BrowserPage> {
    const client = await CDPClient.connectToChrome(port);
    return new BrowserPage(client);
  }
}
