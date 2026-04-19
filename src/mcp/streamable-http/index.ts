/**
 * Streamable HTTP transport for the MCP server (spec 2025-11-25).
 *
 * Endpoints:
 *   GET  /mcp    — server capabilities + supported protocol version
 *   POST /mcp    — JSON-RPC request (response as JSON or SSE per Accept header)
 *   DELETE /mcp  — terminate session (requires MCP-Session-Id)
 *   GET /health  — server status + active session count
 *
 * Session management via the MCP-Session-Id header; protocol-version
 * enforcement via MCP-Protocol-Version. CORS validated per request
 * (no wildcards), DNS-rebinding-safe origin check.
 *
 * Every SSE event carries an explicit `id:` so a future replay buffer
 * can anchor to it. `Last-Event-ID` is accepted for forward-compat
 * testing but replay is not yet implemented.
 *
 * Zero external dependencies — Node.js http + crypto only.
 *
 * Module layout (v0.213.3 P3 split):
 *   ./session.ts      — session state, helpers, types, constants
 *   ./handle-post.ts  — POST /mcp dispatch (sync + async + SSE)
 *   ./index.ts        — public `startStreamableHttp` + routing
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { VERSION, MCP_PROTOCOL_VERSION } from "../../constants.js";
import { handleOAuthRoute, createOAuthMiddleware } from "../oauth.js";
import { handlePost } from "./handle-post.js";
import {
  ALLOWED_ORIGINS,
  HEARTBEAT_MS,
  PRUNE_INTERVAL_MS,
  SESSION_TTL_MS,
  asyncTasks,
  isOriginAllowed,
  jsonResponse,
  pruneStaleSessions,
  sessions,
  type Handler,
  type StreamableHttpOptions,
} from "./session.js";

// ── DELETE /mcp Handler ────────────────────────────────────────────────────

function handleDelete(req: IncomingMessage, res: ServerResponse): void {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    jsonResponse(res, 404, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid or missing MCP-Session-Id" },
    });
    return;
  }
  sessions.delete(sessionId);
  res.writeHead(204);
  res.end();
}

// ── OPTIONS preflight ──────────────────────────────────────────────────────

function handleOptions(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  const allowedOrigin =
    origin && isOriginAllowed(req) ? origin : "http://localhost";
  res.writeHead(204, {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, MCP-Session-Id, MCP-Protocol-Version, Authorization, Accept, X-MCP-Async",
    "Access-Control-Expose-Headers": "MCP-Session-Id, MCP-Protocol-Version",
    "Access-Control-Max-Age": "86400",
  });
  res.end();
}

// ── Routing ────────────────────────────────────────────────────────────────

function route(
  req: IncomingMessage,
  res: ServerResponse,
  handler: Handler,
  oauthMiddleware:
    | ((req: IncomingMessage, res: ServerResponse) => boolean)
    | null,
  auth: boolean | undefined,
): void {
  const method = req.method ?? "";
  const pathname = (req.url ?? "/").split("?")[0];

  if (method === "OPTIONS") return handleOptions(req, res);

  // OAuth routes — always public when auth is enabled
  if (auth && handleOAuthRoute(req, res)) return;

  if (method === "GET" && (pathname === "/health" || pathname === "/")) {
    jsonResponse(res, 200, {
      status: "ok",
      transport: "streamable-http",
      version: VERSION,
      sessions: sessions.size,
      protocolVersion: MCP_PROTOCOL_VERSION,
    });
    return;
  }

  if (pathname === "/mcp") {
    if (oauthMiddleware?.(req, res)) return;

    if (method === "GET") {
      jsonResponse(res, 200, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: "unicli", version: VERSION },
        capabilities: {},
      });
      return;
    }
    if (method === "POST") {
      handlePost(req, res, handler).catch(() => {
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
    if (method === "DELETE") return handleDelete(req, res);
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Start the MCP Streamable HTTP transport server (spec 2025-11-25).
 *
 * Returns the actually-bound port so callers that pass `port: 0` (let
 * the OS pick a free ephemeral port — used by tests to avoid Windows
 * TIME_WAIT collisions) get the real port back.
 */
export async function startStreamableHttp(
  port: number,
  handler: Handler,
  options?: StreamableHttpOptions,
): Promise<number> {
  const oauthMiddleware = options?.auth ? createOAuthMiddleware() : null;

  const pruneTimer = setInterval(pruneStaleSessions, PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  const server = createServer((req, res) =>
    route(req, res, handler, oauthMiddleware, options?.auth),
  );

  server.on("close", () => {
    clearInterval(pruneTimer);
    sessions.clear();
    asyncTasks.clear();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const boundPort = addr && typeof addr === "object" ? addr.port : port;

  process.stderr.write(
    `unicli MCP server v${VERSION} — Streamable HTTP transport on http://127.0.0.1:${boundPort}\n` +
      `  MCP endpoint: GET/POST/DELETE http://127.0.0.1:${boundPort}/mcp\n` +
      `  Health check: GET             http://127.0.0.1:${boundPort}/health\n` +
      `  Protocol:     ${MCP_PROTOCOL_VERSION}\n`,
  );

  return boundPort;
}

// Re-export types for downstream consumers.
export type { Handler, StreamableHttpOptions } from "./session.js";

// Exported for testing. Stable shape: mirrors the pre-split module.
export const _test = {
  sessions,
  asyncTasks,
  pruneStaleSessions,
  isOriginAllowed,
  ALLOWED_ORIGINS,
  SESSION_TTL_MS,
  HEARTBEAT_MS,
  MCP_PROTOCOL_VERSION,
} as const;
