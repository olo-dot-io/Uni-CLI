/**
 * Streamable HTTP transport for the MCP server (spec 2025-03-26).
 *
 * Single endpoint: POST /mcp
 *   - JSON-RPC request in body
 *   - Response as application/json or text/event-stream (per Accept header)
 *   - MCP-Session-Id header for session management
 *   - MCP-Protocol-Version header enforced post-initialization
 *
 * DELETE /mcp — terminate session (requires MCP-Session-Id)
 * GET /health  — server status + active session count
 *
 * Zero external dependencies — Node.js http + crypto only.
 */

import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { VERSION } from "../constants.js";
import { handleOAuthRoute, createOAuthMiddleware } from "./oauth.js";

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
  created: number;
  lastSeen: number;
  protocolVersion: string;
}

interface StreamableHttpOptions {
  auth?: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_BODY = 1_048_576; // 1 MB
const SESSION_TTL_MS = 3_600_000; // 1 hour
const PRUNE_INTERVAL_MS = 300_000; // 5 minutes
const HEARTBEAT_MS = 30_000;
const MCP_PROTOCOL_VERSION = "2025-03-26";
const ALLOWED_ORIGINS = new Set(["http://localhost", "http://127.0.0.1"]);

// Methods that may produce long-running responses — served as SSE when
// the client accepts text/event-stream.
const STREAMING_METHODS = new Set(["tools/call"]);

const sessions = new Map<string, Session>();

// ── Helpers ────────────────────────────────────────────────────────────────

function jsonResponse(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
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

function pruneStaleSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.lastSeen < cutoff) sessions.delete(id);
  }
}

/**
 * Validate Origin header for DNS rebinding protection.
 * Allow requests with no Origin (non-browser clients) or from localhost.
 */
function isOriginAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // Non-browser clients omit Origin
  // Accept any localhost origin regardless of port
  try {
    const url = new URL(origin);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      return true;
    }
  } catch {
    // Malformed origin — reject
  }
  return ALLOWED_ORIGINS.has(origin);
}

function clientAcceptsSSE(req: IncomingMessage): boolean {
  const accept = req.headers.accept ?? "";
  return accept.includes("text/event-stream");
}

// ── POST /mcp Handler ──────────────────────────────────────────────────────

async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  handler: Handler,
): Promise<void> {
  // Origin validation
  if (!isOriginAllowed(req)) {
    jsonResponse(res, 403, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Forbidden: invalid Origin" },
    });
    return;
  }

  // Read and parse body
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

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const isInitialize = parsed.method === "initialize";

  // Session validation: post-init requests require a valid session
  if (!isInitialize) {
    if (!sessionId || !sessions.has(sessionId)) {
      jsonResponse(res, 400, {
        jsonrpc: "2.0",
        id: parsed.id ?? null,
        error: { code: -32600, message: "Invalid or missing MCP-Session-Id" },
      });
      return;
    }
    sessions.get(sessionId)!.lastSeen = Date.now();
  }

  // Notification (no id) — respond 204 No Content
  if (parsed.id === undefined || parsed.id === null) {
    try {
      await handler(parsed);
    } catch {
      // Notifications have no response — swallow errors
    }
    res.writeHead(204);
    res.end();
    return;
  }

  // Execute the handler
  let response: JsonRpcResponse;
  try {
    response = await handler(parsed);
    // Handler returns null for notifications — should not reach here due to
    // the check above, but guard anyway.
    if (!response) {
      res.writeHead(204);
      res.end();
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    jsonResponse(res, 500, {
      jsonrpc: "2.0",
      id: parsed.id ?? null,
      error: { code: -32603, message: `Internal error: ${message}` },
    });
    return;
  }

  // For initialize: create session and return MCP-Session-Id
  if (isInitialize) {
    const newSessionId = randomUUID();
    sessions.set(newSessionId, {
      created: Date.now(),
      lastSeen: Date.now(),
      protocolVersion: MCP_PROTOCOL_VERSION,
    });
    jsonResponse(res, 200, response as unknown as Record<string, unknown>, {
      "MCP-Session-Id": newSessionId,
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    });
    return;
  }

  // For streaming-eligible methods: respond with SSE if client accepts it
  if (STREAMING_METHODS.has(parsed.method) && clientAcceptsSSE(req)) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "MCP-Session-Id": sessionId!,
    });

    // Send the response as an SSE event
    const eventId = randomUUID();
    res.write(
      `id: ${eventId}\nevent: message\ndata: ${JSON.stringify(response)}\n\n`,
    );

    // Close the stream after delivering the response
    res.end();
    return;
  }

  // Default: respond with JSON
  const headers: Record<string, string> = {};
  if (sessionId) headers["MCP-Session-Id"] = sessionId;
  jsonResponse(
    res,
    200,
    response as unknown as Record<string, unknown>,
    headers,
  );
}

// ── DELETE /mcp Handler ────────────────────────────────────────────────────

function handleDelete(req: IncomingMessage, res: ServerResponse): void {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    jsonResponse(res, 400, {
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

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Start the MCP Streamable HTTP transport server (spec 2025-03-26).
 *
 * Single endpoint (POST /mcp) handles all JSON-RPC communication.
 * DELETE /mcp terminates sessions. GET /health returns server info.
 */
export async function startStreamableHttp(
  port: number,
  handler: Handler,
  options?: StreamableHttpOptions,
): Promise<void> {
  const oauthMiddleware = options?.auth ? createOAuthMiddleware() : null;

  // Periodic session pruning
  const pruneTimer = setInterval(pruneStaleSessions, PRUNE_INTERVAL_MS);
  pruneTimer.unref(); // Do not keep process alive for pruning

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? "";
    const pathname = (req.url ?? "/").split("?")[0];

    // CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": req.headers.origin ?? "*",
        "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, MCP-Session-Id, MCP-Protocol-Version, Authorization, Accept",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    // OAuth routes — always public when auth is enabled
    if (options?.auth && handleOAuthRoute(req, res)) return;

    // Health check
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

    // Main MCP endpoint
    if (pathname === "/mcp") {
      // OAuth middleware — block unauthenticated requests
      if (oauthMiddleware?.(req, res)) return;

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

      if (method === "DELETE") {
        handleDelete(req, res);
        return;
      }
    }

    // Not found
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.on("close", () => {
    clearInterval(pruneTimer);
    sessions.clear();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  process.stderr.write(
    `unicli MCP server v${VERSION} — Streamable HTTP transport on http://127.0.0.1:${port}\n` +
      `  MCP endpoint: POST/DELETE http://127.0.0.1:${port}/mcp\n` +
      `  Health check: GET         http://127.0.0.1:${port}/health\n` +
      `  Protocol:     ${MCP_PROTOCOL_VERSION}\n`,
  );
}

// Exported for testing
export const _test = {
  sessions,
  pruneStaleSessions,
  isOriginAllowed,
  ALLOWED_ORIGINS,
  SESSION_TTL_MS,
  HEARTBEAT_MS,
  MCP_PROTOCOL_VERSION,
} as const;
