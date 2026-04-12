/**
 * Core CDP client -- raw WebSocket JSON-RPC over Chrome DevTools Protocol.
 *
 * Zero new runtime dependencies (uses existing `ws` package).
 * Foundation for all browser automation in Uni-CLI.
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
}

export interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

type CDPMessage = CDPResponse | CDPEvent;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── Remote endpoint types ───────────────────────────────────────────

export interface RemoteEndpoint {
  endpoint: string;
  headers: Record<string, string>;
}

// ── Constants ────────────────────────────────────────────────────────

const CDP_SEND_TIMEOUT = 30_000;
const CDP_CONNECT_TIMEOUT = 10_000;
const CDP_DEFAULT_PORT = 9222;
const CDP_FETCH_TIMEOUT = 10_000;

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

  /**
   * Connect to a Chrome tab via WebSocket.
   * Optionally pass headers for authenticated remote endpoints (e.g., Cloudflare).
   */
  async connect(
    wsUrl: string,
    options?: { headers?: Record<string, string> },
  ): Promise<void> {
    if (this.ws) {
      throw new Error("CDPClient is already connected. Call close() first.");
    }

    return new Promise<void>((resolve, reject) => {
      const wsOptions: WebSocket.ClientOptions = {};
      if (options?.headers && Object.keys(options.headers).length > 0) {
        wsOptions.headers = options.headers;
      }
      const ws = new WebSocket(wsUrl, wsOptions);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`CDP connect timeout after ${CDP_CONNECT_TIMEOUT}ms`));
      }, CDP_CONNECT_TIMEOUT);

      ws.on("open", () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      });

      ws.on("error", (err: Error) => {
        clearTimeout(timer);
        debugLog(`WebSocket error: ${err.message}`);
        reject(err);
      });

      ws.on("message", (data: WebSocket.RawData) => {
        this.handleMessage(data);
      });

      ws.on("close", () => {
        this.handleClose();
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
  ): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("CDP connection is not open");
    }

    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `CDP command '${method}' timed out after ${CDP_SEND_TIMEOUT / 1000}s`,
          ),
        );
      }, CDP_SEND_TIMEOUT);

      this.pending.set(id, { resolve, reject, timer });
      const msg: Record<string, unknown> = { id, method, params: params ?? {} };
      if (sessionId) msg.sessionId = sessionId;
      this.ws!.send(JSON.stringify(msg));
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

  /**
   * Unsubscribe from a CDP event.
   */
  off(event: string, handler: (params: unknown) => void): void {
    this.listeners.get(event)?.delete(handler);
  }

  /**
   * Clean disconnect -- reject all pending requests and close WebSocket.
   */
  async close(): Promise<void> {
    const ws = this.ws;
    this.ws = null;

    // Reject all pending requests
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("CDP connection closed"));
    }
    this.pending.clear();
    this.listeners.clear();

    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.close();
    }
  }

  // ── Static methods ───────────────────────────────────────────────

  /**
   * Discover Chrome tabs via HTTP endpoint.
   * Default port: 9222.
   */
  static async discoverTargets(port?: number): Promise<CDPTarget[]> {
    const p = port ?? CDP_DEFAULT_PORT;
    const url = `http://localhost:${String(p)}/json`;
    const raw = await fetchJson(url);

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
  static async connectToChrome(port?: number): Promise<CDPClient> {
    const targets = await CDPClient.discoverTargets(port);
    const target = CDPClient.selectTarget(targets);
    if (!target) {
      throw new Error("No suitable Chrome target found");
    }

    const client = new CDPClient();
    await client.connect(target.webSocketDebuggerUrl);

    // Enable Page domain immediately after connection (matches reference pattern)
    try {
      await client.send("Page.enable");
    } catch {
      debugLog("Failed to enable Page domain (non-fatal)");
    }

    return client;
  }

  /**
   * Connect directly to a remote CDP endpoint (e.g., Cloudflare Browser Rendering).
   * Returns a connected CDPClient ready to use.
   */
  static async connectToRemote(
    endpoint: string,
    headers?: Record<string, string>,
  ): Promise<CDPClient> {
    const client = new CDPClient();
    await client.connect(endpoint, headers ? { headers } : undefined);

    // Enable Page domain immediately after connection
    try {
      await client.send("Page.enable");
    } catch {
      debugLog("Failed to enable Page domain on remote (non-fatal)");
    }

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
      clearTimeout(entry.timer);
      this.pending.delete(msg.id);

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
      const set = this.listeners.get(msg.method);
      if (set) {
        for (const handler of set) {
          handler(msg.params);
        }
      }
    }
  }

  private handleClose(): void {
    debugLog("WebSocket closed");
    // Reject all pending requests on unexpected close
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("CDP connection closed unexpectedly"));
    }
    this.pending.clear();
    this.ws = null;
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
  if (type === "service_worker") return Number.NEGATIVE_INFINITY;
  if (type === "background_page") return Number.NEGATIVE_INFINITY;

  let score = 0;

  // Type scoring
  if (type === "page") score += 100;
  else if (type === "app") score += 120;
  else if (type === "webview") score += 90;
  else if (type === "iframe") score += 20;

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

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = httpRequest(parsed, (res) => {
      const statusCode = res.statusCode ?? 0;
      if (statusCode < 200 || statusCode >= 300) {
        res.resume();
        reject(
          new Error(`Failed to fetch CDP targets: HTTP ${String(statusCode)}`),
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
    });

    req.on("error", reject);
    req.setTimeout(CDP_FETCH_TIMEOUT, () =>
      req.destroy(new Error("Timed out fetching CDP targets")),
    );
    req.end();
  });
}
