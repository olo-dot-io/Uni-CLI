/**
 * @owner       src/mcp/jsonrpc.ts
 * @does        Define and validate the shared JSON-RPC wire envelope, handler contract, and MCP request identity context.
 * @needs       no runtime dependencies
 * @feeds       MCP handler plus stdio, simple HTTP, and Streamable HTTP transports
 * @breaks      Type or validation drift here breaks every MCP transport at compile time or admits malformed requests inconsistently.
 * @invariants  Every transport rejects non-object or malformed envelopes before field access; handler context distinguishes stdio/HTTP, carries one stable MCP session id, and owns request cancellation; handler lifecycle hooks contain durable tasks before a session exits.
 * @side-effects None.
 * @perf        Validation is O(serialized request fields).
 * @concurrency Immutable request-local types.
 * @test        tests/unit/mcp/tools.test.ts, tests/unit/mcp-browser-invocation.test.ts
 * @stability   stable
 * @since       2026-04-01
 */

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpRequestContext {
  transport: "mcp-stdio" | "mcp-http";
  mcpSessionId?: string;
  signal?: AbortSignal;
}

export interface JsonRpcHandler {
  (
    request: JsonRpcRequest,
    context?: McpRequestContext,
  ): JsonRpcResponse | undefined | Promise<JsonRpcResponse | undefined>;
  closeSession?(sessionId: string, reason: string): Promise<void>;
  closeAll?(reason: string): Promise<void>;
}

export type JsonRpcRequestDecodeResult =
  | { ok: true; request: JsonRpcRequest }
  | { ok: false; response: JsonRpcResponse };

export function decodeJsonRpcRequest(
  value: unknown,
): JsonRpcRequestDecodeResult {
  if (!isRecord(value)) return invalidRequest();
  if (value.jsonrpc !== "2.0") return invalidRequest();
  if (typeof value.method !== "string" || value.method.length === 0) {
    return invalidRequest();
  }
  if (Object.hasOwn(value, "id") && !isJsonRpcId(value.id)) {
    return invalidRequest();
  }
  if (Object.hasOwn(value, "params") && !isRecord(value.params)) {
    return invalidRequest();
  }
  return { ok: true, request: value as unknown as JsonRpcRequest };
}

export function parseJsonRpcRequestText(
  text: string,
): JsonRpcRequestDecodeResult {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return {
      ok: false,
      response: jsonRpcError(null, -32_700, "Parse error"),
    };
  }
  return decodeJsonRpcRequest(value);
}

export function jsonRpcError(
  id: JsonRpcResponse["id"],
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function invalidRequest(): JsonRpcRequestDecodeResult {
  return {
    ok: false,
    response: jsonRpcError(null, -32_600, "Invalid Request"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}
