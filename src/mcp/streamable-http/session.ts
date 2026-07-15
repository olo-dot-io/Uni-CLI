/**
 * @owner       src/mcp/streamable-http/session.ts
 * @does        Own Streamable HTTP session/task state plus shared origin, CORS, body, response, and handler contracts.
 * @needs       node:http, MCP origin guard and JSON-RPC types
 * @feeds       streamable handle-post, index, and test shim
 * @breaks      Session/helper drift breaks protocol validation and every Streamable HTTP route.
 * @invariants  Shared maps are the single source of truth; request bodies remain bounded; handler type carries MCP request identity.
 * @side-effects Maintains in-process session/task maps and reads/writes HTTP streams.
 * @perf        O(1) map operations with explicit session/task limits enforced by callers.
 * @concurrency Node's event loop serializes individual mutations; asynchronous tasks share these maps intentionally.
 * @test        tests/unit/mcp/streamable-http.test.ts, tests/unit/mcp-browser-invocation.test.ts
 * @stability   stable
 * @since       2026-04-01
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { isOriginAllowed, ALLOWED_ORIGINS } from "../origin-guard.js";
import type {
  JsonRpcHandler,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../jsonrpc.js";

// Re-exported so `handle-post.ts`, `index.ts`, and the `_test` shim keep
// importing the origin policy and wire types from this module's stable surface.
export { isOriginAllowed, ALLOWED_ORIGINS };
export type { JsonRpcRequest, JsonRpcResponse };

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Handler returns `undefined` for JSON-RPC notifications (no `id`). The
 * widened type (P3 MN1 closeout) matches how `buildHandler` in
 * `../handler.ts` produces the handler — sync OR async returns are both
 * legal, `undefined` represents "no response", and the transport awaits
 * uniformly so the cast-adapt in server.ts is no longer required.
 */
export type Handler = JsonRpcHandler;

export interface Session {
  created: number;
  lastSeen: number;
  protocolVersion: string;
}

export interface AsyncTask {
  id: string;
  sessionId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  progress?: { current: number; total: number; message?: string };
  result?: JsonRpcResponse;
  error?: string;
  created: number;
}

export interface StreamableHttpOptions {
  auth?: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────

export const MAX_BODY = 1_048_576; // 1 MB
export const SESSION_TTL_MS = 3_600_000; // 1 hour
export const PRUNE_INTERVAL_MS = 300_000; // 5 minutes
export const HEARTBEAT_MS = 30_000;
export const MAX_SESSIONS = 100;
export const MAX_ASYNC_TASKS = 200;

/**
 * Methods that may produce long-running responses — served as SSE when
 * the client accepts text/event-stream.
 */
export const STREAMING_METHODS = new Set(["tools/call"]);

// ── Module state ───────────────────────────────────────────────────────────

export const sessions = new Map<string, Session>();
export const asyncTasks = new Map<string, AsyncTask>();

// ── Helpers ────────────────────────────────────────────────────────────────

/** CORS headers injected into every response. Uses validated origin, not wildcard. */
export function corsHeaders(req?: IncomingMessage): Record<string, string> {
  const origin = req?.headers?.origin;
  const allowed = origin && isOriginAllowed(req!) ? origin : "http://localhost";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Expose-Headers": "MCP-Session-Id, MCP-Protocol-Version",
  };
}

/**
 * Emit a JSON-serializable body with the standard response headers.
 * Accepts `JsonRpcResponse` or any `Record<string, unknown>` so call sites
 * can hand over typed responses without `as unknown as Record<…>` casts.
 */
export function jsonResponse(
  res: ServerResponse,
  status: number,
  body: JsonRpcResponse | Record<string, unknown>,
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

export function readBody(req: IncomingMessage): Promise<string> {
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

export function pruneStaleSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.lastSeen < cutoff) sessions.delete(id);
  }
  for (const [id, task] of asyncTasks) {
    if (task.created < cutoff) asyncTasks.delete(id);
  }
}

export function clientAcceptsSSE(req: IncomingMessage): boolean {
  const accept = req.headers.accept ?? "";
  return accept.includes("text/event-stream");
}
