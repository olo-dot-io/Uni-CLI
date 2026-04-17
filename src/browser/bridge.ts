/**
 * BrowserBridge — high-level API for CLI commands to get a browser page
 * via the daemon. Auto-spawns the daemon if not running.
 *
 * DaemonPage — IPage implementation that routes all operations through
 * HTTP to the daemon, which forwards them to the Chrome Extension.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchDaemonStatus, sendCommand } from "./daemon-client.js";
import { getRemoteEndpoint, CDPClient } from "./cdp-client.js";
import { BrowserPage } from "./page.js";
import { isRemoteBrowser } from "./launcher.js";
import type { DaemonCommand } from "./protocol.js";
import type {
  IPage,
  SnapshotOptions,
  ScreenshotOptions,
  NetworkRequest,
} from "../types.js";

// ── Errors ────────────────────────────────────────────────────────

/**
 * Structured connection error for AI agent consumption.
 * Thrown when Chrome/daemon connection fails — always retryable.
 */
export class BridgeConnectionError extends Error {
  readonly retryable = true;
  readonly suggestion = "Run 'unicli browser start' first, then retry.";
  readonly alternatives = ["unicli browser start", "unicli daemon restart"];

  constructor(message: string) {
    super(message);
    this.name = "BridgeConnectionError";
  }

  /** JSON output for AI agents */
  toAgentJSON() {
    return {
      error: this.message,
      retryable: this.retryable,
      step: -1,
      action: "browser_connect",
      suggestion: this.suggestion,
      alternatives: this.alternatives,
      exit_code: 69, // SERVICE_UNAVAILABLE
    };
  }
}

/**
 * Structured connection error for remote CDP endpoints.
 * Thrown when connection to a remote browser fails.
 */
export class RemoteConnectionError extends Error {
  readonly retryable = true;
  readonly suggestion: string;

  constructor(message: string, endpoint: string) {
    super(message);
    this.name = "RemoteConnectionError";
    this.suggestion = `Check that the remote CDP endpoint is reachable: ${endpoint}`;
  }

  /** JSON output for AI agents */
  toAgentJSON() {
    return {
      error: this.message,
      retryable: this.retryable,
      step: -1,
      action: "remote_browser_connect",
      suggestion: this.suggestion,
      alternatives: ["unicli browser start"],
      exit_code: 69, // SERVICE_UNAVAILABLE
    };
  }
}

// ── Constants ──────────────────────────────────────────────────────

const DAEMON_SPAWN_TIMEOUT = 10_000; // 10s to start daemon
const DAEMON_POLL_INTERVAL = 200;
const REMOTE_CONNECT_RETRIES = 2;
const REMOTE_RETRY_DELAY = 1000;

// ── BrowserBridge ──────────────────────────────────────────────────

export class BrowserBridge {
  private _page: DaemonPage | IPage | null = null;
  private _state: "idle" | "connecting" | "connected" | "closed" = "idle";
  private _remotePage: BrowserPage | null = null;

  async connect(opts?: {
    timeout?: number;
    workspace?: string;
  }): Promise<IPage> {
    if (this._state === "connected" && this._page) return this._page;

    this._state = "connecting";

    // Remote browser takes priority — skip daemon entirely
    if (isRemoteBrowser()) {
      const page = await this.connectRemote();
      this._page = page;
      this._remotePage = page;
      this._state = "connected";
      return page;
    }

    const timeout = opts?.timeout ?? DAEMON_SPAWN_TIMEOUT;
    const workspace = opts?.workspace ?? "default";

    await this.ensureDaemon(timeout);

    this._page = new DaemonPage(workspace);
    this._state = "connected";
    return this._page;
  }

  async close(): Promise<void> {
    if (this._remotePage) {
      await this._remotePage.close();
      this._remotePage = null;
    }
    // Does NOT kill daemon — daemon auto-exits on idle
    this._state = "closed";
    this._page = null;
  }

  /**
   * Connect to a remote CDP endpoint with retry logic.
   * Handles Cloudflare Browser Rendering and any standard CDP WebSocket.
   */
  private async connectRemote(): Promise<BrowserPage> {
    const remote = getRemoteEndpoint();
    if (!remote) {
      throw new RemoteConnectionError(
        "UNICLI_CDP_ENDPOINT is not set",
        "(none)",
      );
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= REMOTE_CONNECT_RETRIES; attempt++) {
      try {
        const client = await CDPClient.connectToRemote(
          remote.endpoint,
          Object.keys(remote.headers).length > 0 ? remote.headers : undefined,
        );
        return new BrowserPage(client);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < REMOTE_CONNECT_RETRIES) {
          await new Promise((r) => setTimeout(r, REMOTE_RETRY_DELAY));
        }
      }
    }

    throw new RemoteConnectionError(
      `Failed to connect to remote CDP endpoint after ${String(REMOTE_CONNECT_RETRIES + 1)} attempts: ${lastError?.message ?? "unknown error"}`,
      remote.endpoint,
    );
  }

  private async ensureDaemon(timeout: number): Promise<void> {
    // Check if already running
    let status = await fetchDaemonStatus({ timeout: 1000 });

    if (status) {
      // Running but extension not connected — wait for it
      if (!status.extensionConnected) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, DAEMON_POLL_INTERVAL));
          status = await fetchDaemonStatus({ timeout: 500 });
          if (status?.extensionConnected) return;
        }
        // Extension never connected — continue anyway (some commands work without extension)
      }
      return;
    }

    // Not running — spawn daemon
    const daemonPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "daemon.js",
    );
    const proc = spawn(process.execPath, [daemonPath], {
      detached: true,
      stdio: "ignore",
    });
    proc.unref();

    // Poll until daemon is reachable
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, DAEMON_POLL_INTERVAL));
      status = await fetchDaemonStatus({ timeout: 500 });
      if (status) return;
    }

    throw new BridgeConnectionError(
      `Daemon failed to start within ${timeout / 1000}s. Check if port ${process.env.UNICLI_DAEMON_PORT ?? "19825"} is available.`,
    );
  }
}

// ── DaemonPage ─────────────────────────────────────────────────────

type CommandParams = Omit<DaemonCommand, "id" | "action">;

export class DaemonPage implements IPage {
  constructor(private readonly workspace: string) {}

  private cmdOpts(extra: CommandParams = {}): CommandParams {
    return { workspace: this.workspace, ...extra };
  }

  async goto(
    url: string,
    options?: { settleMs?: number; waitUntil?: string },
  ): Promise<void> {
    await sendCommand("navigate", this.cmdOpts({ url }));
    if (options?.settleMs) {
      await new Promise((r) => setTimeout(r, options.settleMs));
    }
  }

  async evaluate(script: string): Promise<unknown> {
    const result = await sendCommand("exec", this.cmdOpts({ code: script }));
    return (result as { data?: unknown })?.data;
  }

  async wait(seconds: number): Promise<void> {
    await new Promise((r) => setTimeout(r, seconds * 1000));
  }

  async waitForSelector(selector: string, timeout?: number): Promise<void> {
    const maxWait = timeout ?? 10_000;
    const deadline = Date.now() + maxWait;
    while (Date.now() < deadline) {
      const found = await this.evaluate(
        `!!document.querySelector('${selector.replace(/'/g, "\\'")}')`,
      );
      if (found) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`waitForSelector timed out: ${selector}`);
  }

  async waitFor(condition: number | string, timeout?: number): Promise<void> {
    if (typeof condition === "number") {
      await new Promise((r) => setTimeout(r, condition));
    } else {
      await this.waitForSelector(condition, timeout);
    }
  }

  async click(selector: string): Promise<void> {
    const escaped = selector.replace(/'/g, "\\'");
    await sendCommand(
      "exec",
      this.cmdOpts({
        code: `(() => {
        const el = document.querySelector('${escaped}');
        if (!el) throw new Error('Element not found: ${escaped}');
        el.click();
      })()`,
      }),
    );
  }

  async type(selector: string, text: string): Promise<void> {
    await this.click(selector);
    await this.insertText(text);
  }

  async press(key: string, modifiers?: string[]): Promise<void> {
    // Use CDP via daemon for key press
    const params: Record<string, unknown> = {
      type: "keyDown",
      key,
      windowsVirtualKeyCode: key.charCodeAt(0),
    };
    if (modifiers?.length) {
      const MODS: Record<string, number> = {
        alt: 1,
        ctrl: 2,
        meta: 4,
        shift: 8,
      };
      params.modifiers = modifiers.reduce(
        (acc, m) => acc | (MODS[m.toLowerCase()] ?? 0),
        0,
      );
    }
    await sendCommand(
      "cdp",
      this.cmdOpts({
        cdpMethod: "Input.dispatchKeyEvent",
        cdpParams: params,
      }),
    );
    await sendCommand(
      "cdp",
      this.cmdOpts({
        cdpMethod: "Input.dispatchKeyEvent",
        cdpParams: { ...params, type: "keyUp" },
      }),
    );
  }

  async insertText(text: string): Promise<void> {
    await sendCommand("insert-text", this.cmdOpts({ text }));
  }

  async scroll(direction: "down" | "up" | "bottom" | "top"): Promise<void> {
    const scripts: Record<string, string> = {
      down: "window.scrollBy(0, window.innerHeight)",
      up: "window.scrollBy(0, -window.innerHeight)",
      bottom: "window.scrollTo(0, document.body.scrollHeight)",
      top: "window.scrollTo(0, 0)",
    };
    await this.evaluate(scripts[direction]);
  }

  async autoScroll(opts?: {
    maxScrolls?: number;
    delay?: number;
  }): Promise<void> {
    const max = opts?.maxScrolls ?? 20;
    const delay = opts?.delay ?? 1000;
    for (let i = 0; i < max; i++) {
      try {
        const atBottom = await this.evaluate(
          `(() => { window.scrollBy(0, window.innerHeight); return (window.scrollY + window.innerHeight) >= document.body.scrollHeight - 50; })()`,
        );
        if (atBottom) break;
        await new Promise((r) => setTimeout(r, delay));
      } catch {
        break;
      }
    }
  }

  async nativeClick(x: number, y: number): Promise<void> {
    await sendCommand(
      "cdp",
      this.cmdOpts({
        cdpMethod: "Input.dispatchMouseEvent",
        cdpParams: {
          type: "mousePressed",
          x,
          y,
          button: "left",
          clickCount: 1,
        },
      }),
    );
    await sendCommand(
      "cdp",
      this.cmdOpts({
        cdpMethod: "Input.dispatchMouseEvent",
        cdpParams: {
          type: "mouseReleased",
          x,
          y,
          button: "left",
          clickCount: 1,
        },
      }),
    );
  }

  async nativeKeyPress(key: string, modifiers?: string[]): Promise<void> {
    await this.press(key, modifiers);
  }

  async setFileInput(selector: string, files: string[]): Promise<void> {
    await sendCommand("set-file-input", this.cmdOpts({ selector, files }));
  }

  async cookies(): Promise<Record<string, string>> {
    const result = await sendCommand("cookies", this.cmdOpts());
    return (result as Record<string, string>) ?? {};
  }

  async title(): Promise<string> {
    return (await this.evaluate("document.title")) as string;
  }

  async url(): Promise<string> {
    return (await this.evaluate("window.location.href")) as string;
  }

  async snapshot(opts?: SnapshotOptions): Promise<string> {
    const { snapshotWithFingerprint } = await import("./snapshot-helpers.js");
    return snapshotWithFingerprint(this, opts);
  }

  async screenshot(opts?: ScreenshotOptions): Promise<Buffer> {
    const result = await sendCommand(
      "screenshot",
      this.cmdOpts({
        format: opts?.format ?? "png",
        quality: opts?.quality,
        fullPage: opts?.fullPage,
      }),
    );
    const data = (result as { data?: string })?.data ?? "";
    return Buffer.from(data, "base64");
  }

  async startNetworkCapture(pattern?: string): Promise<void> {
    try {
      await sendCommand(
        "network-capture-start",
        this.cmdOpts(pattern ? { pattern } : {}),
      );
    } catch {
      // Daemon/extension may not support this action yet — degrade gracefully
    }
  }

  async readNetworkCapture(): Promise<
    Array<{
      url: string;
      method: string;
      status: number;
      contentType: string;
      size: number;
      responseBody?: string;
    }>
  > {
    try {
      const result = await sendCommand("network-capture-read", this.cmdOpts());
      // daemon-client unwraps { data } already, so result may be the array directly
      if (Array.isArray(result))
        return result as Array<{
          url: string;
          method: string;
          status: number;
          contentType: string;
          size: number;
          responseBody?: string;
        }>;
      const data = (result as { data?: unknown[] })?.data;
      return (Array.isArray(data) ? data : []) as Array<{
        url: string;
        method: string;
        status: number;
        contentType: string;
        size: number;
        responseBody?: string;
      }>;
    } catch {
      return []; // Degrade gracefully if daemon doesn't support this
    }
  }

  async networkRequests(): Promise<NetworkRequest[]> {
    const result = await sendCommand("network-capture-read", this.cmdOpts());
    return (result as NetworkRequest[]) ?? [];
  }

  async addInitScript(source: string): Promise<void> {
    await sendCommand(
      "cdp",
      this.cmdOpts({
        cdpMethod: "Page.addScriptToEvaluateOnNewDocument",
        cdpParams: { source },
      }),
    );
  }

  async sendCDP(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    return sendCommand(
      "cdp",
      this.cmdOpts({
        cdpMethod: method,
        cdpParams: params,
        cdpSessionId: sessionId,
      }),
    );
  }

  async close(): Promise<void> {
    // Don't close the daemon — just release this page reference
  }

  async closeWindow(): Promise<void> {
    await sendCommand("close-window", this.cmdOpts());
  }
}
