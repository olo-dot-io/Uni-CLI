/**
 * @owner       src::mcp::streamable-http::handle-post
 * @does        Classify dual-era Streamable HTTP POSTs, validate modern mirrored headers or legacy sessions, and dispatch JSON/SSE responses with era-correct cancellation.
 * @needs       node:http/crypto, MCP constants/OAuth principal, shared Streamable session helpers
 * @feeds       src/mcp/streamable-http/index.ts
 * @breaks      Transport-owned task state or early disconnect settlement can split durable execution from the handler's authoritative MCP Tasks registry.
 * @invariants  Modern requests validate protocol/method/name headers and use no session; legacy non-initialize requests validate protocol/session/principal; modern stream loss cancels the request; legacy durable work survives socket loss and uses explicit cancellation; initialize is not cancellable; notifications return 202 with no JSON-RPC body.
 * @side-effects Creates bounded sessions, registers/dispatches handlers, streams one SSE event, writes HTTP responses, and processes explicit cancellation.
 * @perf        Request bodies are bounded; task state is not duplicated in the transport.
 * @concurrency Each HTTP request owns one AbortController; shared durable tasks are owned exclusively by McpTaskManager.
 * @test        tests/unit/streamable-http.test.ts, tests/unit/mcp-browser-invocation.test.ts
 * @stability   stable
 * @since       2026-04-01
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
} from "../../constants.js";
import { decodeJsonRpcRequest } from "../jsonrpc.js";
import {
  MCP_TASKS_CAPABILITY_REQUIRED,
  MCP_TASKS_EXTENSION_ID,
} from "../modern-tasks.js";
import { getAuthenticatedPrincipal } from "../oauth.js";
import { StreamableRequestRegistry } from "./request-registry.js";
import {
  clientAcceptsSSE,
  corsHeaders,
  HEARTBEAT_MS,
  isOriginAllowed,
  jsonResponse,
  MAX_SESSIONS,
  canAdmitSession,
  readBody,
  sessions,
  STREAMING_METHODS,
  type Handler,
} from "./session.js";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcServerMessage,
} from "../jsonrpc.js";
import { serializeBoundedJsonRpcMessage } from "../result-budget.js";

type PreflightResult =
  | {
      ok: true;
      parsed: JsonRpcRequest;
      sessionId: string | undefined;
      era: "legacy" | "modern";
    }
  | { ok: false };

function rpcErrorResponse(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown,
): void {
  jsonResponse(
    res,
    status,
    {
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    },
    undefined,
    req,
  );
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function validateModernHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  parsed: JsonRpcRequest,
): boolean {
  if (
    parsed.method === "subscriptions/listen" &&
    typeof parsed.id !== "string" &&
    typeof parsed.id !== "number"
  ) {
    rpcErrorResponse(
      req,
      res,
      400,
      parsed.id ?? null,
      -32_600,
      "subscriptions/listen requires a request id",
    );
    return false;
  }
  const meta = readRecord(parsed.params?._meta);
  if (!meta) {
    rpcErrorResponse(
      req,
      res,
      400,
      parsed.id ?? null,
      -32_602,
      "Missing or invalid required _meta object",
    );
    return false;
  }
  const bodyProtocol = meta?.["io.modelcontextprotocol/protocolVersion"];
  if (typeof bodyProtocol !== "string") {
    rpcErrorResponse(
      req,
      res,
      400,
      parsed.id ?? null,
      -32_602,
      "Missing required _meta field: io.modelcontextprotocol/protocolVersion",
    );
    return false;
  }
  const headerProtocol = req.headers["mcp-protocol-version"];
  if (typeof headerProtocol !== "string" || headerProtocol !== bodyProtocol) {
    rpcErrorResponse(
      req,
      res,
      400,
      parsed.id ?? null,
      -32_020,
      "Header mismatch: MCP-Protocol-Version must match request _meta",
    );
    return false;
  }
  if (bodyProtocol !== MCP_MODERN_PROTOCOL_VERSION) {
    rpcErrorResponse(
      req,
      res,
      400,
      parsed.id ?? null,
      -32_022,
      "Unsupported protocol version",
      {
        supported: [...MCP_SUPPORTED_PROTOCOL_VERSIONS],
        requested: bodyProtocol,
      },
    );
    return false;
  }
  if (req.headers["mcp-method"] !== parsed.method) {
    rpcErrorResponse(
      req,
      res,
      400,
      parsed.id ?? null,
      -32_020,
      "Header mismatch: Mcp-Method must match request method",
    );
    return false;
  }
  const expectedName = standardRequestName(parsed);
  if (expectedName !== undefined) {
    const headerName = req.headers["mcp-name"];
    if (headerName !== expectedName) {
      rpcErrorResponse(
        req,
        res,
        400,
        parsed.id ?? null,
        -32_020,
        "Header mismatch: Mcp-Name must match the request name or URI",
      );
      return false;
    }
  }
  return true;
}

function standardRequestName(parsed: JsonRpcRequest): string | undefined {
  if (parsed.method === "tools/call" || parsed.method === "prompts/get") {
    return typeof parsed.params?.name === "string" ? parsed.params.name : "";
  }
  if (
    parsed.method === "tasks/get" ||
    parsed.method === "tasks/update" ||
    parsed.method === "tasks/cancel"
  ) {
    return typeof parsed.params?.taskId === "string"
      ? parsed.params.taskId
      : "";
  }
  if (parsed.method === "resources/read") {
    return typeof parsed.params?.uri === "string" ? parsed.params.uri : "";
  }
  return undefined;
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
  const meta = readRecord(parsed.params?._meta);
  const modern =
    parsed.method === "server/discover" ||
    meta?.["io.modelcontextprotocol/protocolVersion"] !== undefined ||
    req.headers["mcp-protocol-version"] === MCP_MODERN_PROTOCOL_VERSION;
  if (modern) {
    if (!validateModernHeaders(req, res, parsed)) return { ok: false };
    return { ok: true, parsed, sessionId: undefined, era: "modern" };
  }
  if (
    parsed.method !== "initialize" &&
    !validateSession(req, res, parsed, sessionId)
  ) {
    return { ok: false };
  }
  return { ok: true, parsed, sessionId, era: "legacy" };
}

function handleInitialize(
  req: IncomingMessage,
  res: ServerResponse,
  parsed: JsonRpcRequest,
  response: JsonRpcResponse,
): void {
  const principalId = getAuthenticatedPrincipal(req);
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
  if (!canAdmitSession(principalId)) {
    rpcErrorResponse(
      req,
      res,
      429,
      parsed.id ?? null,
      -32_603,
      "Principal at capacity: too many active sessions",
    );
    return;
  }
  const sessionId = randomUUID();
  const now = Date.now();
  sessions.set(sessionId, {
    created: now,
    lastSeen: now,
    protocolVersion: MCP_PROTOCOL_VERSION,
    ...(principalId ? { principalId } : {}),
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
  era: "legacy" | "modern",
): void {
  if (res.destroyed) return;
  if (
    !response.error &&
    STREAMING_METHODS.has(parsed.method) &&
    clientAcceptsSSE(req)
  ) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...(sessionId ? { "MCP-Session-Id": sessionId } : {}),
      ...(era === "modern"
        ? { "MCP-Protocol-Version": MCP_MODERN_PROTOCOL_VERSION }
        : {}),
      ...corsHeaders(req),
    });
    const eventId = era === "legacy" ? `id: ${randomUUID()}\n` : "";
    res.end(
      `${eventId}event: message\ndata: ${serializeBoundedJsonRpcMessage(response)}\n\n`,
    );
    return;
  }
  const modernHeaders =
    era === "modern"
      ? { "MCP-Protocol-Version": MCP_MODERN_PROTOCOL_VERSION }
      : undefined;
  jsonResponse(
    res,
    era === "modern" ? modernResponseStatus(response) : 200,
    response,
    sessionId ? { "MCP-Session-Id": sessionId } : modernHeaders,
    req,
  );
}

function modernResponseStatus(response: JsonRpcResponse): number {
  if (!response.error) return 200;
  if (response.error.code === -32_601) return 404;
  if (
    response.error.code === -32_020 ||
    response.error.code === -32_021 ||
    response.error.code === -32_022 ||
    response.error.code === -32_602
  ) {
    return 400;
  }
  return 200;
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
      ...(getAuthenticatedPrincipal(req)
        ? { principalId: getAuthenticatedPrincipal(req) }
        : {}),
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
      ...(getAuthenticatedPrincipal(req)
        ? { principalId: getAuthenticatedPrincipal(req) }
        : {}),
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

async function dispatchSubscription(
  req: IncomingMessage,
  res: ServerResponse,
  parsed: JsonRpcRequest,
  handler: Handler,
  signal: AbortSignal,
): Promise<void> {
  if (!clientAcceptsSSE(req)) {
    rpcErrorResponse(
      req,
      res,
      406,
      parsed.id ?? null,
      -32_600,
      "subscriptions/listen requires Accept: text/event-stream",
    );
    return;
  }
  if (
    subscriptionRequestsTaskIds(parsed) &&
    !requestDeclaresTasksCapability(parsed)
  ) {
    rpcErrorResponse(
      req,
      res,
      400,
      parsed.id ?? null,
      MCP_TASKS_CAPABILITY_REQUIRED,
      "Missing required client capability",
      {
        requiredCapabilities: {
          extensions: { [MCP_TASKS_EXTENSION_ID]: {} },
        },
      },
    );
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "MCP-Protocol-Version": MCP_MODERN_PROTOCOL_VERSION,
    ...corsHeaders(req),
  });
  const emitter = createSseEmitter(res);
  const keepAlive = setInterval(() => {
    void emitter.comment().catch((error: unknown) => {
      if (!res.destroyed) {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }, HEARTBEAT_MS);
  keepAlive.unref();
  try {
    const response = await handler(parsed, {
      transport: "mcp-http",
      ...(getAuthenticatedPrincipal(req)
        ? { principalId: getAuthenticatedPrincipal(req) }
        : {}),
      signal,
      emit: emitter.emit,
    });
    if (!signal.aborted && !res.destroyed && response) {
      await emitter.emit(response);
    }
  } catch (error) {
    if (!signal.aborted && !res.destroyed) {
      const message = error instanceof Error ? error.message : String(error);
      await emitter.emit({
        jsonrpc: "2.0",
        id: parsed.id ?? null,
        error: { code: -32_603, message: `Internal error: ${message}` },
      });
    }
  } finally {
    clearInterval(keepAlive);
    try {
      await emitter.drain();
    } catch (error) {
      if (!res.destroyed) {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (!res.destroyed && !res.writableEnded) res.end();
  }
}

function subscriptionRequestsTaskIds(request: JsonRpcRequest): boolean {
  const notifications = readRecord(request.params?.notifications);
  return notifications ? Object.hasOwn(notifications, "taskIds") : false;
}

function requestDeclaresTasksCapability(request: JsonRpcRequest): boolean {
  const meta = readRecord(request.params?._meta);
  const clientCapabilities = readRecord(
    meta?.["io.modelcontextprotocol/clientCapabilities"],
  );
  const extensions = readRecord(clientCapabilities?.extensions);
  return readRecord(extensions?.[MCP_TASKS_EXTENSION_ID]) !== undefined;
}

function createSseEmitter(res: ServerResponse): {
  emit(message: JsonRpcServerMessage): Promise<void>;
  comment(): Promise<void>;
  drain(): Promise<void>;
} {
  let tail = Promise.resolve();
  const append = (payload: string): Promise<void> => {
    const next = tail.then(() => writeSseChunk(res, payload));
    tail = next;
    return next;
  };
  return {
    emit: (message) =>
      append(
        `event: message\ndata: ${serializeBoundedJsonRpcMessage(message)}\n\n`,
      ),
    comment: () => append(":\n\n"),
    drain: () => tail,
  };
}

function writeSseChunk(res: ServerResponse, payload: string): Promise<void> {
  if (res.destroyed || res.writableEnded) {
    return Promise.reject(new Error("MCP subscription stream is closed"));
  }
  if (res.write(payload)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      res.off("drain", drained);
      res.off("error", failed);
      res.off("close", closed);
    };
    const drained = (): void => {
      cleanup();
      resolve();
    };
    const failed = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const closed = (): void => {
      cleanup();
      reject(new Error("MCP subscription stream closed before drain"));
    };
    res.once("drain", drained);
    res.once("error", failed);
    res.once("close", closed);
  });
}

export async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  handler: Handler,
  activeRequests: StreamableRequestRegistry,
): Promise<void> {
  const preflightResult = await preflight(req, res);
  if (!preflightResult.ok) return;
  const { parsed, sessionId, era } = preflightResult;
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
  const abortOnDisconnect = (): void => {
    if (era === "modern" && !res.writableEnded) {
      lease.abort(
        new DOMException(
          "Modern MCP HTTP response stream closed",
          "AbortError",
        ),
      );
    }
  };
  res.once("close", abortOnDisconnect);
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
    if (era === "modern" && parsed.method === "subscriptions/listen") {
      await dispatchSubscription(req, res, parsed, handler, lease.signal);
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
    if (era === "legacy" && parsed.method === "initialize") {
      handleInitialize(req, res, parsed, response);
      return;
    }
    handleResponse(req, res, parsed, sessionId, response, era);
  } finally {
    res.off("close", abortOnDisconnect);
    lease.finish();
  }
}
