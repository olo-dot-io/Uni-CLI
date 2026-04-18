/**
 * Streamable HTTP session + request helpers.
 *
 * Owns the module-level `sessions` / `asyncTasks` maps, the helpers that
 * every POST/DELETE handler shares (CORS, body reading, JSON response),
 * and origin validation. Kept in a single file so `handle-post.ts` and
 * `index.ts` can both import from the same SSOT without circular deps.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

// ── Types ──────────────────────────────────────────────────────────────────

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

/**
 * Handler returns `undefined` for JSON-RPC notifications (no `id`). The
 * widened type (P3 MN1 closeout) matches how `buildHandler` in
 * `../handler.ts` produces the handler — sync OR async returns are both
 * legal, `undefined` represents "no response", and the transport awaits
 * uniformly so the cast-adapt in server.ts is no longer required.
 */
export type Handler = (
  req: JsonRpcRequest,
) => JsonRpcResponse | undefined | Promise<JsonRpcResponse | undefined>;

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
export const ALLOWED_ORIGINS = new Set([
  "http://localhost",
  "http://127.0.0.1",
]);
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

export function jsonResponse(
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

/**
 * Validate Origin header for DNS rebinding protection.
 * Allow requests with no Origin (non-browser clients) or from localhost.
 */
export function isOriginAllowed(req: IncomingMessage): boolean {
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

export function clientAcceptsSSE(req: IncomingMessage): boolean {
  const accept = req.headers.accept ?? "";
  return accept.includes("text/event-stream");
}
