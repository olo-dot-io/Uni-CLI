/**
 * Browser daemon — standalone HTTP + WebSocket server.
 *
 * Bridges CLI commands to the Chrome Extension:
 *   CLI (unicli <cmd>) → HTTP POST /command → daemon → WebSocket /ext → Extension → Chrome tabs
 *
 * Spawned detached by the CLI, runs independently. Auto-exits after idle timeout.
 * Listens on 127.0.0.1:19825 by default.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import WebSocket, { WebSocketServer } from "ws";

import {
  DAEMON_PORT,
  DAEMON_HOST,
  DAEMON_IDLE_TIMEOUT,
  DAEMON_WS_PATH,
  DAEMON_MAX_BODY,
  HEARTBEAT_INTERVAL,
  MAX_MISSED_PONGS,
  type DaemonCommand,
  type DaemonResult,
  type DaemonStatus,
  type ExtensionHello,
  type ExtensionLog,
} from "./protocol.js";
import { IdleManager } from "./idle-manager.js";

// ── Configuration ──────────────────────────────────────────────────

const PORT = parseInt(
  process.env.UNICLI_DAEMON_PORT ?? String(DAEMON_PORT),
  10,
);
const IDLE_TIMEOUT = Number(
  process.env.UNICLI_DAEMON_TIMEOUT ?? DAEMON_IDLE_TIMEOUT,
);

// ── State ──────────────────────────────────────────────────────────

let extensionWs: WebSocket | null = null;
let extensionVersion: string | null = null;

/** Pending CLI→Extension commands awaiting response. */
const pending = new Map<
  string,
  {
    resolve: (data: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

/** Log ring buffer from extension messages + daemon events. */
interface LogEntry {
  level: string;
  msg: string;
  ts: number;
}
const LOG_BUFFER_SIZE = 200;
const logBuffer: LogEntry[] = [];

function pushLog(level: string, msg: string): void {
  logBuffer.push({ level, msg, ts: Date.now() });
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
}

// ── Idle Management ────────────────────────────────────────────────

const startTime = Date.now();

const idleManager = new IdleManager(IDLE_TIMEOUT, () => {
  console.error("[daemon] Idle timeout reached — shutting down");
  shutdown();
});

// ── Body Reader ────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > DAEMON_MAX_BODY) {
        req.destroy();
        reject(new Error("Body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

// ── HTTP Helpers ───────────────────────────────────────────────────

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// ── HTTP Request Handler ───────────────────────────────────────────

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const origin = req.headers["origin"] as string | undefined;

  // Security: reject browser origins that are not the Chrome Extension
  if (origin && !origin.startsWith("chrome-extension://")) {
    json(res, 403, { error: "Forbidden origin" });
    return;
  }

  // OPTIONS — return 204 with no CORS headers (browsers get a definitive "no")
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${DAEMON_HOST}:${PORT}`);
  const path = url.pathname;

  // GET /ping — no auth required, used by extension to probe
  if (req.method === "GET" && path === "/ping") {
    json(res, 200, { ok: true });
    return;
  }

  // X-Unicli header required on all other endpoints
  if (!req.headers["x-unicli"]) {
    json(res, 403, { error: "Missing X-Unicli header" });
    return;
  }

  idleManager.onCliRequest();

  try {
    if (req.method === "GET" && path === "/status") {
      const status: DaemonStatus = {
        ok: true,
        pid: process.pid,
        uptime: Date.now() - startTime,
        extensionConnected: extensionWs !== null,
        extensionVersion: extensionVersion ?? undefined,
        pending: pending.size,
        lastCliRequestTime: idleManager.lastCliRequestTime,
        memoryMB: Math.round(process.memoryUsage.rss() / 1024 / 1024),
        port: PORT,
      };
      json(res, 200, status);
      return;
    }

    if (req.method === "GET" && path === "/logs") {
      const levelFilter = url.searchParams.get("level");
      const entries = levelFilter
        ? logBuffer.filter((e) => e.level === levelFilter)
        : logBuffer;
      json(res, 200, entries);
      return;
    }

    if (req.method === "DELETE" && path === "/logs") {
      logBuffer.length = 0;
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && path === "/shutdown") {
      json(res, 200, { ok: true });
      setTimeout(shutdown, 100);
      return;
    }

    if (req.method === "POST" && path === "/command") {
      await handleCommand(req, res);
      return;
    }

    json(res, 404, { error: "Not found" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    pushLog("error", `HTTP handler error: ${msg}`);
    json(res, 500, { error: msg });
  }
}

// ── Command Handler ────────────────────────────────────────────────

async function handleCommand(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = await readBody(req);
  let body: DaemonCommand;
  try {
    body = JSON.parse(raw) as DaemonCommand;
  } catch {
    json(res, 400, { error: "Invalid JSON" });
    return;
  }

  if (!body.id) {
    json(res, 400, { error: "Missing command id" });
    return;
  }

  if (!extensionWs || extensionWs.readyState !== WebSocket.OPEN) {
    json(res, 503, {
      id: body.id,
      ok: false,
      error: "Extension not connected",
    });
    return;
  }

  const timeoutMs = body.timeout ? body.timeout * 1000 : 120_000;

  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(body.id);
        reject(new Error("Command timed out"));
      }, timeoutMs);

      pending.set(body.id, { resolve, reject, timer });
      extensionWs!.send(JSON.stringify(body));
    });

    json(res, 200, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg === "Command timed out" ? 408 : 502;
    json(res, status, { id: body.id, ok: false, error: msg } as DaemonResult);
  }
}

// ── HTTP Server ────────────────────────────────────────────────────

const httpServer = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("[daemon] Unhandled request error:", err);
    if (!res.headersSent) json(res, 500, { error: "Internal error" });
  });
});

// ── WebSocket Server ───────────────────────────────────────────────

const wss = new WebSocketServer({
  server: httpServer,
  path: DAEMON_WS_PATH,
  verifyClient: (info: { req: IncomingMessage }) => {
    const wsOrigin = info.req.headers["origin"] as string | undefined;
    return !wsOrigin || wsOrigin.startsWith("chrome-extension://");
  },
});

wss.on("connection", (ws: WebSocket) => {
  // Only one extension connection at a time
  if (extensionWs && extensionWs.readyState === WebSocket.OPEN) {
    extensionWs.close(1000, "Replaced by new connection");
  }

  extensionWs = ws;
  extensionVersion = null;
  idleManager.setExtensionConnected(true);
  pushLog("log", "Extension connected");
  console.error("[daemon] Extension connected");

  // Heartbeat: ping every interval, track missed pongs
  let missedPongs = 0;
  const heartbeat = setInterval(() => {
    if (missedPongs >= MAX_MISSED_PONGS) {
      pushLog("warn", "Extension heartbeat timeout — terminating");
      console.error("[daemon] Extension heartbeat timeout — terminating");
      clearInterval(heartbeat);
      ws.terminate();
      return;
    }
    missedPongs++;
    ws.ping();
  }, HEARTBEAT_INTERVAL);

  ws.on("pong", () => {
    missedPongs = 0;
  });

  ws.on("message", (data: WebSocket.RawData) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      pushLog("warn", "Invalid JSON from extension");
      return;
    }

    // Extension hello
    if (msg.type === "hello") {
      const hello = msg as unknown as ExtensionHello;
      extensionVersion = hello.version;
      pushLog("log", `Extension hello: v${hello.version}`);
      console.error(`[daemon] Extension hello: v${hello.version}`);
      return;
    }

    // Extension log forwarding
    if (msg.type === "log") {
      const log = msg as unknown as ExtensionLog;
      pushLog(log.level, log.msg);
      const prefix =
        log.level === "error" ? "❌" : log.level === "warn" ? "⚠️" : "📋";
      console.error(`[ext ${prefix}] ${log.msg}`);
      return;
    }

    // Command result — resolve pending promise
    if (typeof msg.id === "string") {
      const entry = pending.get(msg.id);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(msg.id);
        entry.resolve(msg);
      }
      return;
    }

    pushLog(
      "warn",
      `Unknown message type: ${JSON.stringify(msg).slice(0, 200)}`,
    );
  });

  ws.on("close", () => {
    cleanupExtension("Connection closed");
    clearInterval(heartbeat);
  });

  ws.on("error", (err) => {
    pushLog("error", `WebSocket error: ${err.message}`);
    console.error("[daemon] WebSocket error:", err.message);
    cleanupExtension("Connection error");
    clearInterval(heartbeat);
  });
});

function cleanupExtension(reason: string): void {
  extensionWs = null;
  extensionVersion = null;
  idleManager.setExtensionConnected(false);
  pushLog("log", `Extension disconnected: ${reason}`);
  console.error(`[daemon] Extension disconnected: ${reason}`);

  // Reject all pending requests
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error("Extension disconnected"));
    pending.delete(id);
  }
}

// ── Graceful Shutdown ──────────────────────────────────────────────

function shutdown(): void {
  pushLog("log", "Shutting down");
  console.error("[daemon] Shutting down");

  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error("Daemon shutting down"));
  }
  pending.clear();

  if (extensionWs) {
    extensionWs.close(1000, "Daemon shutting down");
  }

  idleManager.destroy();
  wss.close();
  httpServer.close(() => {
    process.exit(0);
  });

  // Force exit if graceful close takes too long
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ── Start ──────────────────────────────────────────────────────────

httpServer.listen(PORT, DAEMON_HOST, () => {
  console.error(`[daemon] Listening on http://${DAEMON_HOST}:${PORT}`);
  console.error(`[daemon] PID ${process.pid} | idle timeout ${IDLE_TIMEOUT}ms`);
  idleManager.onCliRequest();
});

httpServer.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[daemon] Port ${PORT} already in use`);
    process.exit(69); // SERVICE_UNAVAILABLE
  }
  console.error("[daemon] Server error:", err);
  process.exit(1);
});
