/**
 * SSE (Server-Sent Events) transport for the MCP server.
 *
 * Routes:
 *   GET  /mcp/sse       — opens SSE stream, sends session ID as first event
 *   POST /mcp/message   — accepts JSON-RPC requests (requires ?sessionId=)
 *   GET  /health        — returns server status + active session count
 *
 * Uses Node.js built-in http module. Zero external dependencies.
 */

import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { VERSION } from "../constants.js";

// ── Types ──────────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type Handler = (
  req: JsonRpcRequest,
) => JsonRpcResponse | Promise<JsonRpcResponse>;

interface Session {
  id: string;
  res: ServerResponse;
  heartbeat: ReturnType<typeof setInterval>;
}

// ── Constants & Helpers ────────────────────────────────────────────────────

const HEARTBEAT_MS = 30_000;
const MAX_BODY = 1_048_576; // 1 MB
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "Access-Control-Allow-Origin": "*",
} as const;

const sessions = new Map<string, Session>();

function sendEvent(res: ServerResponse, event: string, data: string): void {
  res.write(`event: ${event}\ndata: ${data}\n\n`);
}

function jsonResponse(
  res: ServerResponse,
  status: number,
  body: JsonRpcResponse | Record<string, unknown>,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function createSession(res: ServerResponse): Session {
  const id = randomUUID();
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(`:ping\n\n`);
  }, HEARTBEAT_MS);
  const session: Session = { id, res, heartbeat };
  sessions.set(id, session);
  return session;
}

function destroySession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  clearInterval(session.heartbeat);
  sessions.delete(id);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error("Request too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ── Route Handlers ─────────────────────────────────────────────────────────

function handleSseConnect(res: ServerResponse): void {
  res.writeHead(200, SSE_HEADERS);
  const session = createSession(res);
  sendEvent(res, "endpoint", `/mcp/message?sessionId=${session.id}`);
  res.on("close", () => destroySession(session.id));
}

async function handleMessage(
  req: IncomingMessage,
  res: ServerResponse,
  handler: Handler,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const sessionId = url.searchParams.get("sessionId");

  if (!sessionId || !sessions.has(sessionId)) {
    jsonResponse(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid or missing sessionId" },
    });
    return;
  }
  const session = sessions.get(sessionId)!;

  let body: string;
  try {
    body = await readBody(req);
  } catch {
    jsonResponse(res, 413, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Request too large" },
    });
    return;
  }

  let parsed: JsonRpcRequest;
  try {
    parsed = JSON.parse(body) as JsonRpcRequest;
  } catch {
    jsonResponse(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }

  try {
    const response = await handler(parsed);
    if (!response) {
      res.writeHead(202);
      res.end();
      return;
    } // JSON-RPC notification
    jsonResponse(res, 200, response);
    // Push response to SSE stream (if still open)
    if (!session.res.writableEnded) {
      sendEvent(session.res, "message", JSON.stringify(response));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    jsonResponse(res, 500, {
      jsonrpc: "2.0",
      id: parsed.id ?? null,
      error: { code: -32603, message: `Internal error: ${message}` },
    });
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Start the SSE transport server on the given port.
 * Reuses the same `buildHandler` from server.ts for JSON-RPC dispatch.
 */
export async function startSseServer(
  port: number,
  handler: Handler,
): Promise<void> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? "";
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

    if (method === "GET" && pathname === "/mcp/sse") {
      handleSseConnect(res);
      return;
    }
    if (method === "POST" && pathname === "/mcp/message") {
      handleMessage(req, res, handler).catch(() => {
        if (!res.writableEnded) {
          jsonResponse(res, 500, {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32603, message: "Unexpected server error" },
          });
        }
      });
      return;
    }
    if (method === "GET" && (pathname === "/health" || pathname === "/")) {
      jsonResponse(res, 200, {
        status: "ok",
        version: VERSION,
        sessions: sessions.size,
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.on("close", () => {
    for (const [id] of sessions) destroySession(id);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  process.stderr.write(
    `unicli MCP server v${VERSION} — SSE transport on http://127.0.0.1:${port}\n` +
      `  SSE endpoint:     GET  http://127.0.0.1:${port}/mcp/sse\n` +
      `  Message endpoint: POST http://127.0.0.1:${port}/mcp/message?sessionId=<id>\n` +
      `  Health check:     GET  http://127.0.0.1:${port}/health\n`,
  );
}
