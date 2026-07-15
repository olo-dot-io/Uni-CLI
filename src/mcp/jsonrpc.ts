/**
 * @owner       src/mcp/jsonrpc.ts
 * @does        Define the shared JSON-RPC wire envelope, handler contract, and MCP request identity context.
 * @needs       no runtime dependencies
 * @feeds       MCP handler plus stdio, simple HTTP, and Streamable HTTP transports
 * @breaks      Type drift here breaks every MCP transport at compile time.
 * @invariants  Handler context distinguishes stdio/HTTP and may carry one stable MCP session id.
 * @side-effects None; type declarations only.
 * @perf        Erased at runtime.
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
}

export type JsonRpcHandler = (
  request: JsonRpcRequest,
  context?: McpRequestContext,
) => JsonRpcResponse | undefined | Promise<JsonRpcResponse | undefined>;
