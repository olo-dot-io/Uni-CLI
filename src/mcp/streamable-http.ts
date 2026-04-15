/**
 * Streamable HTTP transport for the MCP server (spec 2025-11-25).
 *
 * Endpoints:
 *   GET  /mcp  — server capabilities and supported protocol version
 *   POST /mcp  — JSON-RPC request (response as JSON or SSE per Accept header)
 *   DELETE /mcp — terminate session (requires MCP-Session-Id)
 *   GET /health — server status + active session count
 *
 * Session management via MCP-Session-Id header.
 * MCP-Protocol-Version header enforced post-initialization.
 * CORS headers on all responses (not just OPTIONS preflight).
 *
 * Event ID / Last-Event-ID (spec 2025-11-25 §5.3 SSE resumability):
 *   - Every SSE event carries an `id:` line.
 *   - On POST requests with Accept: text/event-stream, the server reads
 *     the `Last-Event-ID` header and logs it so future replay work can
 *     plug into the same path. Full replay lands in v0.213 once the
 *     server maintains a persistent per-session event buffer — today
 *     the current single-response SSE path terminates after one event,
 *     so there is nothing to replay, but a compliant client can still
 *     include the header without breaking.
 *
 * Zero external dependencies — Node.js http + crypto only.
 */

import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { VERSION, MCP_PROTOCOL_VERSION } from "../constants.js";
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

interface AsyncTask {
  id: string;
  sessionId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  progress?: { current: number; total: number; message?: string };
  result?: JsonRpcResponse;
  error?: string;
  created: number;
}

interface StreamableHttpOptions {
  auth?: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_BODY = 1_048_576; // 1 MB
const SESSION_TTL_MS = 3_600_000; // 1 hour
const PRUNE_INTERVAL_MS = 300_000; // 5 minutes
const HEARTBEAT_MS = 30_000;
// MCP_PROTOCOL_VERSION imported from ../constants.js (single source of truth)
const ALLOWED_ORIGINS = new Set(["http://localhost", "http://127.0.0.1"]);
const MAX_SESSIONS = 100;
const MAX_ASYNC_TASKS = 200;

// Methods that may produce long-running responses — served as SSE when
// the client accepts text/event-stream.
const STREAMING_METHODS = new Set(["tools/call"]);

const sessions = new Map<string, Session>();
const asyncTasks = new Map<string, AsyncTask>();

// ── Helpers ────────────────────────────────────────────────────────────────

/** CORS headers injected into every response. Uses validated origin, not wildcard. */
function corsHeaders(req?: IncomingMessage): Record<string, string> {
  const origin = req?.headers?.origin;
  const allowed = origin && isOriginAllowed(req!) ? origin : "http://localhost";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Expose-Headers": "MCP-Session-Id, MCP-Protocol-Version",
  };
}

function jsonResponse(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
  req?: IncomingMessage,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...corsHeaders(req),
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
  for (const [id, task] of asyncTasks) {
    if (task.created < cutoff) asyncTasks.delete(id);
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

// ── Async Task Handlers ───────────────────────────────────────────────────

function handleTaskStatus(
  parsed: JsonRpcRequest,
  sessionId: string,
): JsonRpcResponse {
  const taskId = (parsed.params as { taskId?: string } | undefined)?.taskId;
  if (!taskId) {
    return {
      jsonrpc: "2.0",
      id: parsed.id ?? null,
      error: { code: -32602, message: "Missing required param: taskId" },
    };
  }
  const task = asyncTasks.get(taskId);
  if (!task || task.sessionId !== sessionId) {
    return {
      jsonrpc: "2.0",
      id: parsed.id ?? null,
      error: { code: -32602, message: "Task not found" },
    };
  }
  const resultPayload: Record<string, unknown> = {
    taskId: task.id,
    status: task.status,
  };
  if (task.progress) resultPayload.progress = task.progress;
  if (task.status === "completed" && task.result) {
    resultPayload.result = task.result;
  }
  if (task.status === "failed" && task.error) {
    resultPayload.error = task.error;
  }
  return { jsonrpc: "2.0", id: parsed.id ?? null, result: resultPayload };
}

function handleTaskCancel(
  parsed: JsonRpcRequest,
  sessionId: string,
): JsonRpcResponse {
  const taskId = (parsed.params as { taskId?: string } | undefined)?.taskId;
  if (!taskId) {
    return {
      jsonrpc: "2.0",
      id: parsed.id ?? null,
      error: { code: -32602, message: "Missing required param: taskId" },
    };
  }
  const task = asyncTasks.get(taskId);
  if (!task || task.sessionId !== sessionId) {
    return {
      jsonrpc: "2.0",
      id: parsed.id ?? null,
      error: { code: -32602, message: "Task not found" },
    };
  }
  if (task.status === "running") {
    task.status = "cancelled";
  }
  return {
    jsonrpc: "2.0",
    id: parsed.id ?? null,
    result: { taskId: task.id, status: task.status },
  };
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

  // Session validation: post-init requests require a valid session.
  // MCP spec: expired/invalid session returns HTTP 404 (not 400).
  if (!isInitialize) {
    if (!sessionId || !sessions.has(sessionId)) {
      jsonResponse(res, 404, {
        jsonrpc: "2.0",
        id: parsed.id ?? null,
        error: { code: -32600, message: "Invalid or missing MCP-Session-Id" },
      });
      return;
    }

    // MCP spec 2025-11-25: MCP-Protocol-Version header required post-init.
    const clientProtocol = req.headers["mcp-protocol-version"] as
      | string
      | undefined;
    if (!clientProtocol) {
      jsonResponse(res, 400, {
        jsonrpc: "2.0",
        id: parsed.id ?? null,
        error: {
          code: -32600,
          message: "Missing MCP-Protocol-Version header",
        },
      });
      return;
    }
    if (clientProtocol !== MCP_PROTOCOL_VERSION) {
      jsonResponse(res, 400, {
        jsonrpc: "2.0",
        id: parsed.id ?? null,
        error: {
          code: -32600,
          message: `Unsupported protocol version: ${clientProtocol}`,
        },
      });
      return;
    }

    sessions.get(sessionId)!.lastSeen = Date.now();
  }

  // Route async task management methods — these are handled internally,
  // never forwarded to the application handler.
  if (parsed.method === "tasks/status" && parsed.id != null) {
    const headers: Record<string, string> = {};
    if (sessionId) headers["MCP-Session-Id"] = sessionId;
    jsonResponse(
      res,
      200,
      handleTaskStatus(parsed, sessionId!) as unknown as Record<
        string,
        unknown
      >,
      headers,
    );
    return;
  }

  if (parsed.method === "tasks/cancel" && parsed.id != null) {
    const headers: Record<string, string> = {};
    if (sessionId) headers["MCP-Session-Id"] = sessionId;
    jsonResponse(
      res,
      200,
      handleTaskCancel(parsed, sessionId!) as unknown as Record<
        string,
        unknown
      >,
      headers,
    );
    return;
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

  // Async task mode: client opts in via X-MCP-Async header for tools/call
  const wantsAsync =
    parsed.method === "tools/call" &&
    req.headers["x-mcp-async"] === "true" &&
    sessionId;

  if (wantsAsync) {
    if (asyncTasks.size >= MAX_ASYNC_TASKS) {
      jsonResponse(
        res,
        503,
        {
          jsonrpc: "2.0",
          id: parsed.id ?? null,
          error: {
            code: -32603,
            message: "Server at capacity: too many active tasks",
          },
        },
        undefined,
        req,
      );
      return;
    }
    const taskId = randomUUID();
    const task: AsyncTask = {
      id: taskId,
      sessionId: sessionId!,
      status: "running",
      created: Date.now(),
    };
    asyncTasks.set(taskId, task);

    // If client accepts SSE, keep connection open and stream progress + completion
    if (clientAcceptsSSE(req)) {
      // Spec 2025-11-25 §5.3: a reconnecting client MAY send Last-Event-ID
      // so the server can resume after the last delivered event. v0.212
      // does not yet maintain a persistent replay buffer (the SSE path is
      // one-shot per POST), so we accept and log the header for
      // forward-compat testing without advertising resumability. Full
      // replay is tracked in docs/ROADMAP.md > v0.213.
      const lastEventId = req.headers["last-event-id"] as string | undefined;
      if (lastEventId && process.env.UNICLI_DEBUG) {
        process.stderr.write(
          `mcp: Last-Event-ID=${lastEventId} received (replay lands in v0.213)\n`,
        );
      }

      res.writeHead(202, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "MCP-Session-Id": sessionId!,
        ...corsHeaders(req),
      });

      // Send the accepted event immediately. Every SSE event now carries
      // an explicit `id:` so a future replay buffer can anchor to it.
      const acceptedId = randomUUID();
      res.write(
        `id: ${acceptedId}\nevent: accepted\ndata: ${JSON.stringify({ taskId, status: "running" })}\n\n`,
      );

      // Execute the handler in the background
      Promise.resolve(handler(parsed)).then(
        (result: JsonRpcResponse) => {
          if (task.status === "cancelled") {
            if (!res.writableEnded) {
              res.write(
                `id: ${randomUUID()}\nevent: cancelled\ndata: ${JSON.stringify({ taskId })}\n\n`,
              );
              res.end();
            }
            return;
          }
          task.status = "completed";
          task.result = result;
          if (!res.writableEnded) {
            res.write(
              `id: ${randomUUID()}\nevent: complete\ndata: ${JSON.stringify({ taskId, result })}\n\n`,
            );
            res.end();
          }
        },
        (err: unknown) => {
          if (task.status === "cancelled") {
            if (!res.writableEnded) {
              res.write(
                `id: ${randomUUID()}\nevent: cancelled\ndata: ${JSON.stringify({ taskId })}\n\n`,
              );
              res.end();
            }
            return;
          }
          const msg = err instanceof Error ? err.message : String(err);
          task.status = "failed";
          task.error = msg;
          if (!res.writableEnded) {
            res.write(
              `id: ${randomUUID()}\nevent: error\ndata: ${JSON.stringify({ taskId, error: msg })}\n\n`,
            );
            res.end();
          }
        },
      );
      return;
    }

    // Non-SSE async: return 202 with task ID immediately, execute in background
    Promise.resolve(handler(parsed)).then(
      (result: JsonRpcResponse) => {
        if (task.status === "cancelled") return;
        task.status = "completed";
        task.result = result;
      },
      (err: unknown) => {
        if (task.status === "cancelled") return;
        const msg = err instanceof Error ? err.message : String(err);
        task.status = "failed";
        task.error = msg;
      },
    );

    jsonResponse(
      res,
      202,
      {
        jsonrpc: "2.0",
        id: parsed.id,
        result: { _meta: { taskId, status: "running" } },
      },
      { "MCP-Session-Id": sessionId!, ...corsHeaders(req) },
      req,
    );
    return;
  }

  // Execute the handler (synchronous path)
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
    if (sessions.size >= MAX_SESSIONS) {
      jsonResponse(
        res,
        503,
        {
          jsonrpc: "2.0",
          id: parsed.id ?? null,
          error: {
            code: -32603,
            message: "Server at capacity: too many active sessions",
          },
        },
        undefined,
        req,
      );
      return;
    }
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
      ...corsHeaders(req),
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
  // MCP spec: expired/invalid session returns HTTP 404 (not 400).
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

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Start the MCP Streamable HTTP transport server (spec 2025-11-25).
 *
 * GET /mcp returns server capabilities. POST /mcp handles JSON-RPC.
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

    // CORS preflight — use same origin validation as responses
    if (method === "OPTIONS") {
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

      // GET /mcp — return server metadata and supported protocol version.
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
    asyncTasks.clear();
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
      `  MCP endpoint: GET/POST/DELETE http://127.0.0.1:${port}/mcp\n` +
      `  Health check: GET             http://127.0.0.1:${port}/health\n` +
      `  Protocol:     ${MCP_PROTOCOL_VERSION}\n`,
  );
}

// Exported for testing
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
