/**
 * @owner       src::mcp::streamable-http::session
 * @does        Own Streamable HTTP session identity, expiry, principal binding, and shared bounded HTTP helpers.
 * @needs       node:http, MCP origin guard and JSON-RPC contracts
 * @feeds       Streamable HTTP POST dispatch and server lifecycle
 * @breaks      A stale, unbounded, or cross-principal session can expose another Agent's durable task state or retain browser authority indefinitely.
 * @invariants  Session ids are receiver-generated; each session binds one protocol version and optional OAuth principal; stale sessions are removed before asynchronous task containment; request bodies and session count are bounded.
 * @side-effects Maintains the process-local session registry and reads/writes HTTP streams.
 * @perf        O(1) session lookup, O(session count) expiry with a hard maximum.
 * @concurrency Node's event loop serializes registry changes; expiry removes identity before awaiting external containment.
 * @test        tests/unit/streamable-http.test.ts, tests/unit/mcp-browser-invocation.test.ts
 * @stability   stable
 * @since       2026-04-01
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { JsonRpcHandler, JsonRpcResponse } from "../jsonrpc.js";
import { ALLOWED_ORIGINS, isOriginAllowed } from "../origin-guard.js";
import { serializeBoundedJsonRpcMessage } from "../result-budget.js";

export { ALLOWED_ORIGINS, isOriginAllowed };
export type Handler = JsonRpcHandler;

export interface Session {
  created: number;
  lastSeen: number;
  protocolVersion: string;
  principalId?: string;
}

export interface StreamableHttpOptions {
  auth?: boolean;
}

export const MAX_BODY = 1_048_576;
export const SESSION_TTL_MS = 3_600_000;
export const PRUNE_INTERVAL_MS = 300_000;
export const HEARTBEAT_MS = 30_000;
export const MAX_SESSIONS = 100;
export const MAX_SESSIONS_PER_PRINCIPAL = 25;
export const STREAMING_METHODS = new Set(["tools/call"]);

export const sessions = new Map<string, Session>();

export function canAdmitSession(principalId?: string): boolean {
  const principalKey = principalId ?? "<anonymous>";
  let count = 0;
  for (const session of sessions.values()) {
    if ((session.principalId ?? "<anonymous>") !== principalKey) continue;
    count += 1;
    if (count >= MAX_SESSIONS_PER_PRINCIPAL) return false;
  }
  return true;
}

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
  res.end(
    "jsonrpc" in body
      ? serializeBoundedJsonRpcMessage(body as JsonRpcResponse)
      : JSON.stringify(body),
  );
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

export async function pruneStaleSessions(
  closeSession?: (sessionId: string, reason: string) => Promise<void>,
  now = Date.now(),
): Promise<void> {
  const cutoff = now - SESSION_TTL_MS;
  const expired: string[] = [];
  for (const [id, session] of sessions) {
    if (session.lastSeen >= cutoff) continue;
    sessions.delete(id);
    expired.push(id);
  }
  if (closeSession) {
    await Promise.all(
      expired.map((id) => closeSession(id, "MCP session expired")),
    );
  }
}

export function clientAcceptsSSE(req: IncomingMessage): boolean {
  const accept = req.headers.accept ?? "";
  return accept.includes("text/event-stream");
}
