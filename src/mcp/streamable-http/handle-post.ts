/**
 * POST /mcp — request dispatch for the Streamable HTTP transport.
 *
 * Covers six request shapes:
 *   1. Notification (no `id`)              → 204 No Content
 *   2. `tasks/status` / `tasks/cancel`      → synchronous task mgmt
 *   3. Async `tools/call` with SSE client   → 202 + event stream
 *   4. Async `tools/call` without SSE       → 202 + background task
 *   5. `initialize`                         → allocates a session, 200
 *   6. Sync method (default)                → 200 JSON (or SSE event)
 *
 * Session and protocol-version validation for every non-initialize call
 * live here; session state itself is imported from `./session.ts`.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MCP_PROTOCOL_VERSION } from "../../constants.js";
import {
  clientAcceptsSSE,
  corsHeaders,
  isOriginAllowed,
  jsonResponse,
  readBody,
  sessions,
  asyncTasks,
  MAX_SESSIONS,
  MAX_ASYNC_TASKS,
  STREAMING_METHODS,
  type AsyncTask,
  type Handler,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./session.js";

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

// ── Body parse + session validation ────────────────────────────────────────

type PreflightResult =
  | { ok: true; parsed: JsonRpcRequest; sessionId: string | undefined }
  | { ok: false };

function rpcErrorResponse(
  res: ServerResponse,
  status: number,
  id: number | string | null,
  code: number,
  message: string,
): void {
  jsonResponse(res, status, {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

async function readAndParse(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<JsonRpcRequest | undefined> {
  if (!isOriginAllowed(req)) {
    rpcErrorResponse(res, 403, null, -32600, "Forbidden: invalid Origin");
    return undefined;
  }
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    rpcErrorResponse(res, 413, null, -32600, "Request too large");
    return undefined;
  }
  try {
    return JSON.parse(body) as JsonRpcRequest;
  } catch {
    rpcErrorResponse(res, 400, null, -32700, "Parse error");
    return undefined;
  }
}

function validateSession(
  req: IncomingMessage,
  res: ServerResponse,
  parsed: JsonRpcRequest,
  sessionId: string | undefined,
): boolean {
  if (!sessionId || !sessions.has(sessionId)) {
    rpcErrorResponse(
      res,
      404,
      parsed.id ?? null,
      -32600,
      "Invalid or missing MCP-Session-Id",
    );
    return false;
  }
  const clientProtocol = req.headers["mcp-protocol-version"] as
    | string
    | undefined;
  if (!clientProtocol) {
    rpcErrorResponse(
      res,
      400,
      parsed.id ?? null,
      -32600,
      "Missing MCP-Protocol-Version header",
    );
    return false;
  }
  if (clientProtocol !== MCP_PROTOCOL_VERSION) {
    rpcErrorResponse(
      res,
      400,
      parsed.id ?? null,
      -32600,
      `Unsupported protocol version: ${clientProtocol}`,
    );
    return false;
  }
  sessions.get(sessionId)!.lastSeen = Date.now();
  return true;
}

async function preflight(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<PreflightResult> {
  const parsed = await readAndParse(req, res);
  if (!parsed) return { ok: false };

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (parsed.method !== "initialize") {
    if (!validateSession(req, res, parsed, sessionId)) return { ok: false };
  }
  return { ok: true, parsed, sessionId };
}

// ── Async task dispatch (SSE + background) ────────────────────────────────

function writeSseEvent(
  res: ServerResponse,
  event: string,
  data: Record<string, unknown>,
): void {
  if (res.writableEnded) return;
  res.write(
    `id: ${randomUUID()}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
  if (event !== "accepted") res.end();
}

function logLastEventId(req: IncomingMessage): void {
  // Spec 2025-11-25 §5.3: a reconnecting client MAY send Last-Event-ID
  // so the server can resume after the last delivered event. Replay lands
  // in a later release — until then we log the header for forward-compat
  // testing without advertising resumability.
  const lastEventId = req.headers["last-event-id"] as string | undefined;
  if (lastEventId && process.env.UNICLI_DEBUG) {
    process.stderr.write(
      `mcp: Last-Event-ID=${lastEventId} received (replay not enabled yet)\n`,
    );
  }
}

function startAsyncSse(
  req: IncomingMessage,
  res: ServerResponse,
  parsed: JsonRpcRequest,
  sessionId: string,
  handler: Handler,
): void {
  const taskId = randomUUID();
  const task: AsyncTask = {
    id: taskId,
    sessionId,
    status: "running",
    created: Date.now(),
  };
  asyncTasks.set(taskId, task);

  logLastEventId(req);

  res.writeHead(202, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "MCP-Session-Id": sessionId,
    ...corsHeaders(req),
  });

  // Accepted event stays open — writeSseEvent keeps the stream alive for
  // this event only, and closes it for complete/cancelled/error.
  writeSseEvent(res, "accepted", { taskId, status: "running" });

  Promise.resolve(handler(parsed)).then(
    (result) => {
      if (task.status === "cancelled") {
        writeSseEvent(res, "cancelled", { taskId });
        return;
      }
      task.status = "completed";
      task.result = result;
      writeSseEvent(res, "complete", { taskId, result: result ?? null });
    },
    (err: unknown) => {
      if (task.status === "cancelled") {
        writeSseEvent(res, "cancelled", { taskId });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      task.status = "failed";
      task.error = msg;
      writeSseEvent(res, "error", { taskId, error: msg });
    },
  );
}

function startAsyncBackground(
  req: IncomingMessage,
  res: ServerResponse,
  parsed: JsonRpcRequest,
  sessionId: string,
  handler: Handler,
): void {
  const taskId = randomUUID();
  const task: AsyncTask = {
    id: taskId,
    sessionId,
    status: "running",
    created: Date.now(),
  };
  asyncTasks.set(taskId, task);

  Promise.resolve(handler(parsed)).then(
    (result) => {
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
    { "MCP-Session-Id": sessionId, ...corsHeaders(req) },
    req,
  );
}

// ── Sub-handlers for specific request shapes ──────────────────────────────

function handleTaskMethod(
  res: ServerResponse,
  parsed: JsonRpcRequest,
  sessionId: string | undefined,
): boolean {
  const fn =
    parsed.method === "tasks/status"
      ? handleTaskStatus
      : parsed.method === "tasks/cancel"
        ? handleTaskCancel
        : undefined;
  if (!fn || parsed.id == null) return false;
  const headers: Record<string, string> = {};
  if (sessionId) headers["MCP-Session-Id"] = sessionId;
  jsonResponse(res, 200, fn(parsed, sessionId!), headers);
  return true;
}

async function handleNotification(
  res: ServerResponse,
  parsed: JsonRpcRequest,
  handler: Handler,
): Promise<void> {
  try {
    await handler(parsed);
  } catch {
    /* Notifications have no response — swallow errors */
  }
  res.writeHead(204);
  res.end();
}

function handleAsync(
  req: IncomingMessage,
  res: ServerResponse,
  parsed: JsonRpcRequest,
  sessionId: string,
  handler: Handler,
): void {
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
  if (clientAcceptsSSE(req)) {
    startAsyncSse(req, res, parsed, sessionId, handler);
  } else {
    startAsyncBackground(req, res, parsed, sessionId, handler);
  }
}

function handleInitialize(
  res: ServerResponse,
  parsed: JsonRpcRequest,
  response: JsonRpcResponse,
): void {
  if (sessions.size >= MAX_SESSIONS) {
    jsonResponse(res, 503, {
      jsonrpc: "2.0",
      id: parsed.id ?? null,
      error: {
        code: -32603,
        message: "Server at capacity: too many active sessions",
      },
    });
    return;
  }
  const newSessionId = randomUUID();
  sessions.set(newSessionId, {
    created: Date.now(),
    lastSeen: Date.now(),
    protocolVersion: MCP_PROTOCOL_VERSION,
  });
  jsonResponse(res, 200, response, {
    "MCP-Session-Id": newSessionId,
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
  });
}

function handleSyncResponse(
  req: IncomingMessage,
  res: ServerResponse,
  parsed: JsonRpcRequest,
  sessionId: string | undefined,
  response: JsonRpcResponse,
): void {
  if (STREAMING_METHODS.has(parsed.method) && clientAcceptsSSE(req)) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "MCP-Session-Id": sessionId!,
      ...corsHeaders(req),
    });
    const eventId = randomUUID();
    res.write(
      `id: ${eventId}\nevent: message\ndata: ${JSON.stringify(response)}\n\n`,
    );
    res.end();
    return;
  }
  const headers: Record<string, string> = {};
  if (sessionId) headers["MCP-Session-Id"] = sessionId;
  jsonResponse(res, 200, response, headers);
}

async function runHandlerSafe(
  res: ServerResponse,
  parsed: JsonRpcRequest,
  handler: Handler,
): Promise<JsonRpcResponse | undefined | null> {
  try {
    const response = await handler(parsed);
    if (!response) {
      res.writeHead(204);
      res.end();
      return null;
    }
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    jsonResponse(res, 500, {
      jsonrpc: "2.0",
      id: parsed.id ?? null,
      error: { code: -32603, message: `Internal error: ${message}` },
    });
    return null;
  }
}

// ── POST /mcp main entry ──────────────────────────────────────────────────

/**
 * Handle a POST /mcp request. Reads and parses the body, validates the
 * session + protocol version, and dispatches to the sync, async-SSE, or
 * async-background path. Notifications (no `id`) respond with 204.
 */
export async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  handler: Handler,
): Promise<void> {
  const pre = await preflight(req, res);
  if (!pre.ok) return;
  const { parsed, sessionId } = pre;

  if (handleTaskMethod(res, parsed, sessionId)) return;

  if (parsed.id === undefined || parsed.id === null) {
    await handleNotification(res, parsed, handler);
    return;
  }

  const wantsAsync =
    parsed.method === "tools/call" &&
    req.headers["x-mcp-async"] === "true" &&
    sessionId;
  if (wantsAsync) {
    handleAsync(req, res, parsed, sessionId!, handler);
    return;
  }

  const response = await runHandlerSafe(res, parsed, handler);
  if (response === null) return;
  if (!response) return;

  if (parsed.method === "initialize") {
    handleInitialize(res, parsed, response);
    return;
  }

  handleSyncResponse(req, res, parsed, sessionId, response);
}
