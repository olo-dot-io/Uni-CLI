/**
 * @owner       src/browser/cdp-client.ts
 * @does        Provide raw browser-level, target-level, and flattened session-scoped Chrome DevTools Protocol connections.
 * @needs       node:http, ws
 * @feeds       src/browser/page.ts, src/browser/managed-browser.ts, src/browser/remote-browser.ts, transport CDP adapters
 * @breaks      Throws on invalid endpoints, unavailable targets, protocol errors, connection loss, and command timeouts.
 * @invariants  Every request id resolves once; abort removes only that request and ignores any late response; close waits for or forcibly terminates its exact socket before reconnect; flattened-session events never cross session listeners; target selection excludes non-page surfaces.
 * @side-effects Opens HTTP and WebSocket connections and mutates pending-request/listener state.
 * @perf        O(1) pending dispatch; target discovery is O(number of exposed DevTools targets).
 * @concurrency Multiple in-flight commands are correlated by id; close rejects every pending command.
 * @test        tests/unit/cdp-client.test.ts, tests/integration/browser-runtime-broker.test.ts, tests/integration/browser-remote-provider.test.ts
 * @stability   experimental
 * @since       2026-04-04
 */

import WebSocket from "ws";
import { request as httpRequest } from "node:http";

// ── Types ────────────────────────────────────────────────────────────

interface CDPResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface CDPEvent {
  method: string;
  params?: unknown;
  sessionId?: string;
}

export interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface CDPBrowserVersion {
  Browser: string;
  "Protocol-Version"?: string;
  "User-Agent"?: string;
  "V8-Version"?: string;
  "WebKit-Version"?: string;
  webSocketDebuggerUrl: string;
}

type CDPMessage = CDPResponse | CDPEvent;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

export interface ConnectToChromeOptions {
  freshPage?: boolean;
  pageUrl?: string;
}

// ── Remote endpoint types ───────────────────────────────────────────

export interface RemoteEndpoint {
  endpoint: string;
  headers: Record<string, string>;
}

export interface CDPCommandClient {
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
  on(event: string, handler: (params: unknown) => void): void;
  off(event: string, handler: (params: unknown) => void): void;
  close(): Promise<void>;
  getConnectedTarget(): CDPTarget | undefined;
}

type CDPCommandTransportErrorCode =
  | "cdp_connection_not_open"
  | "cdp_command_timeout"
  | "cdp_command_send_failed"
  | "cdp_connection_lost";

interface CDPCommandTransportErrorOptions extends ErrorOptions {
  outcomeAmbiguous: boolean;
  targetUnusable: boolean;
}

export class CDPCommandTransportError extends Error {
  readonly retryable = true;
  readonly suggestion =
    "Inspect the target state before retrying a mutation; reconnect before issuing another CDP command.";
  readonly outcome_ambiguous: boolean;
  readonly target_unusable: boolean;

  constructor(
    readonly code: CDPCommandTransportErrorCode,
    message: string,
    options: CDPCommandTransportErrorOptions,
  ) {
    super(message, options);
    this.name = "CDPCommandTransportError";
    this.outcome_ambiguous = options.outcomeAmbiguous;
    this.target_unusable = options.targetUnusable;
  }
}

// ── Constants ────────────────────────────────────────────────────────

const CDP_SEND_TIMEOUT = 30_000;
const CDP_CONNECT_TIMEOUT = 10_000;
const CDP_CLOSE_TIMEOUT = 5_000;
const CDP_TERMINATE_TIMEOUT = 1_000;
const CDP_DEFAULT_PORT = 9222;
const CDP_FETCH_TIMEOUT = 10_000;
const NON_NAVIGABLE_TARGET_TYPES = new Set([
  "app",
  "background_page",
  "iframe",
  "other",
  "service_worker",
  "webview",
]);

// ── Helpers ──────────────────────────────────────────────────────────

function isDebugEnabled(): boolean {
  return (
    process.env.UNICLI_DEBUG === "1" || process.env.UNICLI_DEBUG === "true"
  );
}

function debugLog(message: string): void {
  if (isDebugEnabled()) {
    process.stderr.write(`[cdp-client] ${message}\n`);
  }
}

/**
 * Resolve the CDP port from an explicit argument or UNICLI_CDP_PORT, with one
 * consistent semantic across every caller: explicit wins, else a set env var is
 * validated and THROWS on a malformed value (a bad port is a configuration error
 * the agent must see, not a silent fall-back to 9222), else the default.
 *
 * This replaces four divergent inline parsers (cookie-extractor threw, while
 * cookie-refresh / browser-helpers / launcher silently kept 9222 on garbage).
 */
export function resolveCdpPort(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const raw = process.env.UNICLI_CDP_PORT;
  if (!raw) return CDP_DEFAULT_PORT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(
      `Invalid UNICLI_CDP_PORT: "${raw}" — expected an integer in 1..65535`,
    );
  }
  return parsed;
}

function isCDPResponse(msg: CDPMessage): msg is CDPResponse {
  return "id" in msg && typeof (msg as CDPResponse).id === "number";
}

function isCDPEvent(msg: CDPMessage): msg is CDPEvent {
  return "method" in msg && typeof (msg as CDPEvent).method === "string";
}

// ── CDPClient ────────────────────────────────────────────────────────

export class CDPClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private listeners = new Map<string, Set<(params: unknown) => void>>();
  private sessionListeners = new Map<
    string,
    Map<string, Set<(params: unknown) => void>>
  >();
  private connectedTarget?: CDPTarget;
  private closing: Promise<void> | null = null;

  /**
   * Connect to a Chrome tab via WebSocket.
   * Optionally pass headers for authenticated remote endpoints (e.g., Cloudflare).
   */
  async connect(
    wsUrl: string,
    options?: { headers?: Record<string, string> },
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (this.ws || this.closing) {
      throw new Error(
        "CDPClient is already connected or closing. Await close() before reconnecting.",
      );
    }

    return new Promise<void>((resolve, reject) => {
      const wsOptions: WebSocket.ClientOptions = {};
      if (options?.headers && Object.keys(options.headers).length > 0) {
        wsOptions.headers = options.headers;
      }
      const ws = new WebSocket(wsUrl, wsOptions);
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const abort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        ws.terminate();
        reject(signal?.reason ?? new Error("CDP connection cancelled"));
      };
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        ws.terminate();
        reject(new Error(`CDP connect timeout after ${CDP_CONNECT_TIMEOUT}ms`));
      }, CDP_CONNECT_TIMEOUT);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();

      ws.on("open", () => {
        if (settled) {
          ws.terminate();
          return;
        }
        settled = true;
        cleanup();
        this.ws = ws;
        resolve();
      });

      ws.on("error", (err: Error) => {
        debugLog(`WebSocket error: ${err.message}`);
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      });

      ws.on("message", (data: WebSocket.RawData) => {
        this.handleMessage(data);
      });

      ws.on("close", () => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error("CDP connection closed before opening"));
          return;
        }
        this.handleClose(ws);
      });
    });
  }

  /**
   * Send a CDP command and await response.
   * Times out after 30 seconds by default.
   */
  async send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new CDPCommandTransportError(
        "cdp_connection_not_open",
        "CDP connection is not open",
        { outcomeAmbiguous: false, targetUnusable: true },
      );
    }

    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      let entry!: PendingRequest;
      const timer = setTimeout(() => {
        if (this.pending.get(id) !== entry) return;
        this.clearPendingRequest(id, entry);
        reject(
          new CDPCommandTransportError(
            "cdp_command_timeout",
            `CDP command '${method}' timed out after ${CDP_SEND_TIMEOUT / 1000}s`,
            { outcomeAmbiguous: true, targetUnusable: false },
          ),
        );
      }, CDP_SEND_TIMEOUT);

      const abortHandler = (): void => {
        if (this.pending.get(id) !== entry) return;
        this.clearPendingRequest(id, entry);
        reject(signal?.reason);
      };
      entry = {
        resolve,
        reject,
        timer,
        ...(signal ? { signal, abortHandler } : {}),
      };
      this.pending.set(id, entry);
      signal?.addEventListener("abort", abortHandler, { once: true });
      const msg: Record<string, unknown> = { id, method, params: params ?? {} };
      if (sessionId) msg.sessionId = sessionId;
      try {
        this.ws!.send(JSON.stringify(msg), (error) => {
          if (!error || this.pending.get(id) !== entry) return;
          this.clearPendingRequest(id, entry);
          reject(
            new CDPCommandTransportError(
              "cdp_command_send_failed",
              `CDP command '${method}' send failed: ${error.message}`,
              {
                cause: error,
                outcomeAmbiguous: true,
                targetUnusable: true,
              },
            ),
          );
        });
      } catch (error) {
        this.clearPendingRequest(id, entry);
        reject(
          new CDPCommandTransportError(
            "cdp_command_send_failed",
            `CDP command '${method}' could not be handed to the socket: ${error instanceof Error ? error.message : String(error)}`,
            {
              cause: error,
              outcomeAmbiguous: false,
              targetUnusable: true,
            },
          ),
        );
      }
    });
  }

  /**
   * Subscribe to a CDP event (e.g. "Page.loadEventFired").
   */
  on(event: string, handler: (params: unknown) => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
  }

  getConnectedTarget(): CDPTarget | undefined {
    return this.connectedTarget;
  }

  /**
   * Unsubscribe from a CDP event.
   */
  off(event: string, handler: (params: unknown) => void): void {
    this.listeners.get(event)?.delete(handler);
  }

  onSession(
    sessionId: string,
    event: string,
    handler: (params: unknown) => void,
  ): void {
    let listeners = this.sessionListeners.get(sessionId);
    if (!listeners) {
      listeners = new Map();
      this.sessionListeners.set(sessionId, listeners);
    }
    let handlers = listeners.get(event);
    if (!handlers) {
      handlers = new Set();
      listeners.set(event, handlers);
    }
    handlers.add(handler);
  }

  offSession(
    sessionId: string,
    event: string,
    handler: (params: unknown) => void,
  ): void {
    this.sessionListeners.get(sessionId)?.get(event)?.delete(handler);
  }

  clearSessionListeners(sessionId: string): void {
    this.sessionListeners.delete(sessionId);
  }

  /**
   * Clean disconnect -- reject all pending requests and close WebSocket.
   */
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    const ws = this.ws;
    this.connectedTarget = undefined;

    // Reject all pending requests
    for (const entry of this.pending.values()) {
      this.clearPendingRequest(undefined, entry);
      entry.reject(
        new CDPCommandTransportError(
          "cdp_connection_lost",
          "CDP connection closed",
          { outcomeAmbiguous: true, targetUnusable: true },
        ),
      );
    }
    this.pending.clear();
    this.listeners.clear();
    this.sessionListeners.clear();

    if (!ws || ws.readyState === WebSocket.CLOSED) {
      if (this.ws === ws) this.ws = null;
      return;
    }
    let closing!: Promise<void>;
    closing = waitForWebSocketClose(ws).finally(() => {
      if (this.ws === ws) this.ws = null;
      if (this.closing === closing) this.closing = null;
    });
    this.closing = closing;
    return closing;
  }

  // ── Static methods ───────────────────────────────────────────────

  /**
   * Discover Chrome tabs via HTTP endpoint.
   * Default port: 9222.
   */
  static async discoverTargets(
    port?: number,
    signal?: AbortSignal,
  ): Promise<CDPTarget[]> {
    const p = port ?? CDP_DEFAULT_PORT;
    const url = `http://127.0.0.1:${String(p)}/json`;
    const raw = await fetchJson(url, undefined, signal);

    if (!Array.isArray(raw)) {
      throw new Error("CDP /json did not return an array");
    }

    return raw.filter(
      (t): t is CDPTarget =>
        typeof t === "object" &&
        t !== null &&
        typeof (t as Record<string, unknown>).webSocketDebuggerUrl === "string",
    );
  }

  static async discoverBrowser(
    port?: number,
    signal?: AbortSignal,
  ): Promise<CDPBrowserVersion> {
    const p = port ?? CDP_DEFAULT_PORT;
    const raw = await fetchJson(
      `http://127.0.0.1:${String(p)}/json/version`,
      undefined,
      signal,
    );
    if (
      typeof raw !== "object" ||
      raw === null ||
      typeof (raw as Record<string, unknown>).Browser !== "string" ||
      typeof (raw as Record<string, unknown>).webSocketDebuggerUrl !== "string"
    ) {
      throw new Error("CDP /json/version returned an invalid browser endpoint");
    }
    return raw as CDPBrowserVersion;
  }

  /**
   * Select the best tab from a list of targets.
   * Prefers type=page, avoids devtools/service_worker/background.
   */
  static selectTarget(targets: CDPTarget[]): CDPTarget | null {
    let best: CDPTarget | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const target of targets) {
      const score = scoreTarget(target);
      if (score > bestScore) {
        bestScore = score;
        best = target;
      }
    }

    return Number.isFinite(bestScore) ? best : null;
  }

  /**
   * Convenience: discover + select + connect.
   * Returns a connected CDPClient ready to use.
   */
  static async connectToChrome(
    port?: number,
    options: ConnectToChromeOptions = {},
  ): Promise<CDPClient> {
    const targets = await CDPClient.discoverTargets(port);
    const target =
      options.freshPage === true
        ? await CDPClient.createTarget(port, options.pageUrl ?? "about:blank")
        : (CDPClient.selectTarget(targets) ??
          (await CDPClient.createTarget(
            port,
            options.pageUrl ?? "about:blank",
          )));
    if (!target) {
      throw new Error("No suitable Chrome target found");
    }

    const client = new CDPClient();
    await client.connect(target.webSocketDebuggerUrl);
    client.connectedTarget = target;

    // Enable Page domain immediately after connection (matches reference pattern)
    try {
      await client.send("Page.enable");
    } catch (err) {
      if (options.freshPage === true) {
        await client.close();
        throw err;
      }
      debugLog("Failed to enable Page domain (non-fatal)");
    }

    return client;
  }

  static async connectToBrowser(
    port?: number,
    signal?: AbortSignal,
  ): Promise<CDPClient> {
    const browser = await CDPClient.discoverBrowser(port, signal);
    const client = new CDPClient();
    await client.connect(browser.webSocketDebuggerUrl, undefined, signal);
    return client;
  }

  static async connectToTarget(
    targetId: string,
    port?: number,
    signal?: AbortSignal,
  ): Promise<CDPClient> {
    signal?.throwIfAborted();
    const target = (await CDPClient.discoverTargets(port, signal)).find(
      (candidate) => candidate.id === targetId,
    );
    if (!target) {
      throw new Error(`Chrome target not found: ${targetId}`);
    }
    const client = new CDPClient();
    await client.connect(target.webSocketDebuggerUrl, undefined, signal);
    client.connectedTarget = target;
    await client.send("Page.enable", undefined, undefined, signal);
    return client;
  }

  /**
   * Create a page target through Chrome's DevTools HTTP endpoint.
   * Used when Chrome was launched with --no-startup-window and /json is empty.
   */
  static async createTarget(
    port?: number,
    url: string = "about:blank",
  ): Promise<CDPTarget | null> {
    const p = port ?? CDP_DEFAULT_PORT;
    const raw = await fetchJson(
      `http://127.0.0.1:${String(p)}/json/new?${encodeURIComponent(url)}`,
      { method: "PUT" },
    );
    if (
      typeof raw === "object" &&
      raw !== null &&
      typeof (raw as Record<string, unknown>).webSocketDebuggerUrl === "string"
    ) {
      return raw as CDPTarget;
    }
    return null;
  }

  /** Connect directly to an explicit remote CDP WebSocket endpoint. */
  static async connectToRemote(
    endpoint: string,
    headers?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<CDPClient> {
    const client = new CDPClient();
    await client.connect(endpoint, headers ? { headers } : undefined, signal);
    return client;
  }

  // ── Private ──────────────────────────────────────────────────────

  private handleMessage(data: WebSocket.RawData): void {
    let msg: CDPMessage;
    try {
      msg = JSON.parse(data.toString()) as CDPMessage;
    } catch {
      debugLog("Failed to parse CDP message");
      return;
    }

    // Handle responses (messages with an id matching a pending request)
    if (isCDPResponse(msg) && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id)!;
      this.clearPendingRequest(msg.id, entry);

      if (msg.error) {
        entry.reject(
          new Error(
            `CDP error [${String(msg.error.code)}]: ${msg.error.message}`,
          ),
        );
      } else {
        entry.resolve(msg.result);
      }
    }

    // Handle events (messages with a method field)
    if (isCDPEvent(msg)) {
      const set = msg.sessionId
        ? this.sessionListeners.get(msg.sessionId)?.get(msg.method)
        : this.listeners.get(msg.method);
      if (set) {
        for (const handler of set) {
          handler(msg.params);
        }
      }
    }
  }

  private handleClose(ws: WebSocket): void {
    if (this.ws !== ws) return;
    debugLog("WebSocket closed");
    // Reject all pending requests on unexpected close
    for (const entry of this.pending.values()) {
      this.clearPendingRequest(undefined, entry);
      entry.reject(
        new CDPCommandTransportError(
          "cdp_connection_lost",
          "CDP connection closed unexpectedly",
          { outcomeAmbiguous: true, targetUnusable: true },
        ),
      );
    }
    this.pending.clear();
    this.ws = null;
    this.connectedTarget = undefined;
    this.listeners.clear();
    this.sessionListeners.clear();
  }

  private clearPendingRequest(
    id: number | undefined,
    entry: PendingRequest,
  ): void {
    if (id !== undefined && this.pending.get(id) === entry) {
      this.pending.delete(id);
    }
    clearTimeout(entry.timer);
    if (entry.signal && entry.abortHandler) {
      entry.signal.removeEventListener("abort", entry.abortHandler);
    }
  }
}

function waitForWebSocketClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let terminateTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = (): void => {
      clearTimeout(closeTimer);
      if (terminateTimer) clearTimeout(terminateTimer);
      ws.off("close", onClose);
    };
    const onClose = (): void => {
      cleanup();
      resolve();
    };
    const closeTimer = setTimeout(() => {
      ws.terminate();
      terminateTimer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `CDP WebSocket did not close within ${String(CDP_TERMINATE_TIMEOUT)}ms after forced termination`,
          ),
        );
      }, CDP_TERMINATE_TIMEOUT);
    }, CDP_CLOSE_TIMEOUT);
    ws.once("close", onClose);
    try {
      ws.close();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

export class CDPSessionClient implements CDPCommandClient {
  private closed = false;

  constructor(
    private readonly root: CDPClient,
    private readonly sessionId: string,
    private readonly connectedTarget: CDPTarget,
  ) {}

  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("CDP session is closed"));
    if (sessionId && sessionId !== this.sessionId) {
      return Promise.reject(
        new Error("A scoped CDP client cannot address another session"),
      );
    }
    return this.root.send(method, params, this.sessionId, signal);
  }

  on(event: string, handler: (params: unknown) => void): void {
    if (this.closed) throw new Error("CDP session is closed");
    this.root.onSession(this.sessionId, event, handler);
  }

  off(event: string, handler: (params: unknown) => void): void {
    this.root.offSession(this.sessionId, event, handler);
  }

  getConnectedTarget(): CDPTarget {
    return this.connectedTarget;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.root.clearSessionListeners(this.sessionId);
  }
}

// ── Target scoring ───────────────────────────────────────────────────

function scoreTarget(target: CDPTarget): number {
  const type = (target.type ?? "").toLowerCase();
  const url = (target.url ?? "").toLowerCase();
  const title = (target.title ?? "").toLowerCase();
  const haystack = `${title} ${url}`;

  // Hard exclusions
  if (haystack.includes("devtools")) return Number.NEGATIVE_INFINITY;
  if (NON_NAVIGABLE_TARGET_TYPES.has(type)) {
    return Number.NEGATIVE_INFINITY;
  }
  if (type !== "page") return Number.NEGATIVE_INFINITY;

  let score = 0;

  // Type scoring
  score += 100;

  // URL scoring
  if (url && url !== "about:blank" && !url.startsWith("chrome://")) {
    score += 30;
  }
  if (url === "about:blank" || url === "") {
    score -= 40;
  }

  // Title bonus
  if (title && title.length > 0) {
    score += 25;
  }

  return score;
}

// Exported for testing
export const __test__ = {
  scoreTarget,
  getRemoteEndpoint,
};

// ── Remote endpoint helper ──────────────────────────────────────────

/**
 * Check for a remote CDP endpoint configured via environment variables.
 *
 * - UNICLI_CDP_ENDPOINT: WebSocket URL (e.g., wss://browser.example.com)
 * - UNICLI_CDP_HEADERS: Optional JSON string of headers for auth
 *   (e.g., '{"CF-Access-Client-Id":"...","CF-Access-Client-Secret":"..."}')
 *
 * Returns null if no remote endpoint is configured.
 */
export function getRemoteEndpoint(): RemoteEndpoint | null {
  const endpoint = process.env.UNICLI_CDP_ENDPOINT;
  if (!endpoint) return null;

  let headers: Record<string, string> = {};
  const headersJson = process.env.UNICLI_CDP_HEADERS;
  if (headersJson) {
    try {
      const parsed: unknown = JSON.parse(headersJson);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        const filtered = Object.entries(
          parsed as Record<string, unknown>,
        ).filter((kv): kv is [string, string] => typeof kv[1] === "string");
        headers = Object.fromEntries(filtered);
      }
    } catch {
      debugLog(
        "Failed to parse UNICLI_CDP_HEADERS — expected JSON object, ignoring",
      );
    }
  }

  return { endpoint, headers };
}

// ── HTTP fetch helper ────────────────────────────────────────────────

function fetchJson(
  url: string,
  options?: { method?: "GET" | "PUT" },
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = httpRequest(
      parsed,
      { method: options?.method ?? "GET" },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          reject(
            new Error(
              `Failed to fetch CDP targets: HTTP ${String(statusCode)}`,
            ),
          );
          return;
        }

        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );

    const abort = (): void => {
      req.destroy(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("CDP discovery cancelled"),
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
    req.once("close", () => signal?.removeEventListener("abort", abort));
    if (signal?.aborted) abort();
    req.on("error", reject);
    req.setTimeout(CDP_FETCH_TIMEOUT, () =>
      req.destroy(new Error("Timed out fetching CDP targets")),
    );
    req.end();
  });
}
