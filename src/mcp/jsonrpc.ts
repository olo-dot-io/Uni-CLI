/**
 * JSON-RPC 2.0 wire types — single source of truth for the MCP surface.
 *
 * The request/response envelope is shared by the dispatcher (`handler.ts`)
 * and every transport (stdio, legacy HTTP, Streamable HTTP). Defining it
 * once here keeps the transports from re-declaring drifting copies, the same
 * class of divergence that left the legacy HTTP transport without an origin
 * guard. Both `handler.ts` and `streamable-http/session.ts` re-export these
 * so existing import paths stay stable.
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
