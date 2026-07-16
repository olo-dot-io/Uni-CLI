/**
 * @owner       src::mcp::streamable-http::handle-post
 * @does        Validate and dispatch Streamable HTTP initialize, notification, JSON, and single-event SSE MCP POST requests with cross-connection explicit cancellation.
 * @needs       node:http/crypto, MCP constants/OAuth principal, shared Streamable session helpers
 * @feeds       src/mcp/streamable-http/index.ts
 * @breaks      Transport-owned task state or early disconnect settlement can split durable execution from the handler's authoritative MCP Tasks registry.
 * @invariants  Every non-initialize request validates protocol/session/principal; durable task creation and ordinary requests survive socket loss; only notifications/cancelled aborts the typed live request generation; initialize is not cancellable; notifications return 202 with no JSON-RPC body.
 * @side-effects Creates bounded sessions, registers/dispatches handlers, streams one SSE event, writes HTTP responses, and processes explicit cancellation.
 * @perf        Request bodies are bounded; task state is not duplicated in the transport.
 * @concurrency Each HTTP request owns one AbortController; shared durable tasks are owned exclusively by McpTaskManager.
 * @test        tests/unit/streamable-http.test.ts, tests/unit/mcp-browser-invocation.test.ts
 * @stability   stable
 * @since       2026-04-01
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { MCP_PROTOCOL_VERSION } from "../../constants.js";
import { decodeJsonRpcRequest } from "../jsonrpc.js";
import { getAuthenticatedPrincipal } from "../oauth.js";
import { StreamableRequestRegistry } from "./request-registry.js";
import {
  clientAcceptsSSE,
  corsHeaders,
  isOriginAllowed,
  jsonResponse,
  MAX_SESSIONS,
  readBody,
  sessions,
  STREAMING_METHODS,
  type Handler,
} from "./session.js";
import type { JsonRpcRequest, JsonRpcResponse } from "../jsonrpc.js";

type PreflightResult =
  | { ok: true; parsed: JsonRpcRequest; sessionId: string | undefined }
  | { ok: false };

function rpcErrorResponse(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  id: number | string | null,
  code: number,
  message: string,
): void {
  jsonResponse(
    res,
    status,
    { jsonrpc: "2.0", id, error: { code, message } },
    undefined,
    req,
  );
}

async function readAndParse(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<JsonRpcRequest | undefined> {
  if (!isOriginAllowed(req)) {
    rpcErrorResponse(req, res, 403, null, -32_600, "Forbidden: invalid Origin");
    return undefined;
  }
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    rpcErrorResponse(req, res, 413, null, -32_600, "Request too large");
    return undefined;
  }
  try {
    const decoded = decodeJsonRpcRequest(JSON.parse(body) as unknown);
    if (!decoded.ok) {
      jsonResponse(res, 400, decoded.response, undefined, req);
      return undefined;
    }
    return decoded.request;
  } catch {
    rpcErrorResponse(req, res, 400, null, -32_700, "Parse error");
    return undefined;
  }
}

function validateSession(
  req: IncomingMessage,
  res: ServerResponse,
  parsed: JsonRpcRequest,
  sessionId: string | undefined,
): boolean {
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) {
    rpcErrorResponse(
      req,
      res,
      404,
      parsed.id ?? null,
      -32_600,
      "Invalid or missing MCP-Session-Id",
    );
    return false;
  }
  const principalId = getAuthenticatedPrincipal(req);
  if (session.principalId !== principalId) {
    rpcErrorResponse(
      req,
      res,
      403,
      parsed.id ?? null,
      -32_600,
      "MCP session belongs to a different authenticated client",
    );
    return false;
  }
  const clientProtocol = req.headers["mcp-protocol-version"] as
    | string
    | undefined;
  if (!clientProtocol) {
    rpcErrorResponse(
      req,
      res,
      400,
      parsed.id ?? null,
      -32_600,
      "Missing MCP-Protocol-Version header",
    );
    return false;
  }
  if (clientProtocol !== MCP_PROTOCOL_VERSION) {
    rpcErrorResponse(
      req,
      res,
      400,
      parsed.id ?? null,
      -32_600,
      `Unsupported protocol version: ${clientProtocol}`,
    );
    return false;
  }
  session.lastSeen = Date.now();
  return true;
}

async function preflight(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<PreflightResult> {
  const parsed = await readAndParse(req, res);
  if (!parsed) return { ok: false };
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (
    parsed.method !== "initialize" &&
    !validateSession(req, res, parsed, sessionId)
  ) {
    return { ok: false };
  }
  return { ok: true, parsed, sessionId };
}

function handleInitialize(
  req: IncomingMessage,
  res: ServerResponse,
  parsed: JsonRpcRequest,
  response: JsonRpcResponse,
): void {
  if (sessions.size >= MAX_SESSIONS) {
    rpcErrorResponse(
      req,
      res,
      503,
      parsed.id ?? null,
      -32_603,
      "Server at capacity: too many active sessions",
    );
    return;
  }
  const sessionId = randomUUID();
  const now = Date.now();
  sessions.set(sessionId, {
    created: now,
    lastSeen: now,
    protocolVersion: MCP_PROTOCOL_VERSION,
    ...(getAuthenticatedPrincipal(req)
      ? { principalId: getAuthenticatedPrincipal(req) }
      : {}),
  });
  jsonResponse(
    res,
    200,
    response,
    {
      "MCP-Session-Id": sessionId,
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    },
    req,
  );
}

function handleResponse(
  req: IncomingMessage,
  res: ServerResponse,
  parsed: JsonRpcRequest,
  sessionId: string | undefined,
  response: JsonRpcResponse,
): void {
  if (res.destroyed) return;
  if (STREAMING_METHODS.has(parsed.method) && clientAcceptsSSE(req)) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...(sessionId ? { "MCP-Session-Id": sessionId } : {}),
      ...corsHeaders(req),
    });
    res.end(
      `id: ${randomUUID()}\nevent: message\ndata: ${JSON.stringify(response)}\n\n`,
    );
    return;
  }
  jsonResponse(
    res,
    200,
    response,
    sessionId ? { "MCP-Session-Id": sessionId } : undefined,
    req,
  );
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  parsed: JsonRpcRequest,
  handler: Handler,
  signal: AbortSignal,
  sessionId?: string,
): Promise<JsonRpcResponse | undefined> {
  try {
    const response = await handler(parsed, {
      transport: "mcp-http",
      ...(sessionId ? { mcpSessionId: sessionId } : {}),
      signal,
    });
    if (signal.aborted || res.destroyed) return undefined;
    return response;
  } catch (error) {
    if (signal.aborted || res.destroyed) return undefined;
    const message = error instanceof Error ? error.message : String(error);
    rpcErrorResponse(
      req,
      res,
      500,
      parsed.id ?? null,
      -32_603,
      `Internal error: ${message}`,
    );
    return undefined;
  }
}

async function dispatchNotification(
  req: IncomingMessage,
  res: ServerResponse,
  parsed: JsonRpcRequest,
  handler: Handler,
  signal: AbortSignal,
  sessionId?: string,
): Promise<void> {
  try {
    await handler(parsed, {
      transport: "mcp-http",
      ...(sessionId ? { mcpSessionId: sessionId } : {}),
      signal,
    });
  } catch (error) {
    if (!signal.aborted) {
      process.stderr.write(
        `[unicli-mcp] notification ${parsed.method} failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  if (!res.destroyed && !res.writableEnded) {
    res.writeHead(202, corsHeaders(req));
    res.end();
  }
}

export async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  handler: Handler,
  activeRequests: StreamableRequestRegistry,
): Promise<void> {
  const preflightResult = await preflight(req, res);
  if (!preflightResult.ok) return;
  const { parsed, sessionId } = preflightResult;
  if (parsed.method === "notifications/cancelled") {
    if (sessionId) activeRequests.cancel(sessionId, parsed.params?.requestId);
    if (!res.destroyed) {
      res.writeHead(202, corsHeaders(req));
      res.end();
    }
    return;
  }
  const lease = activeRequests.register(sessionId, parsed.id, parsed.method);
  if (lease instanceof Error) {
    const atCapacity = lease.message.startsWith("Server at capacity");
    rpcErrorResponse(
      req,
      res,
      atCapacity ? 503 : 409,
      parsed.id ?? null,
      atCapacity ? -32_603 : -32_600,
      lease.message,
    );
    return;
  }
  try {
    if (!Object.hasOwn(parsed, "id")) {
      await dispatchNotification(
        req,
        res,
        parsed,
        handler,
        lease.signal,
        sessionId,
      );
      return;
    }
    const response = await dispatch(
      req,
      res,
      parsed,
      handler,
      lease.signal,
      sessionId,
    );
    if (response === undefined) {
      if (!res.destroyed && lease.signal.aborted) {
        res.writeHead(202, corsHeaders(req));
        res.end();
      }
      return;
    }
    if (res.destroyed) return;
    if (parsed.method === "initialize") {
      handleInitialize(req, res, parsed, response);
      return;
    }
    handleResponse(req, res, parsed, sessionId, response);
  } finally {
    lease.finish();
  }
}
