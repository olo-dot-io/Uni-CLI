/**
 * @owner       src::mcp::streamable-http::request-registry
 * @does        Track bounded in-flight Streamable HTTP requests across connections for explicit MCP cancellation and awaited session/server containment.
 * @needs       node:crypto, MCP JSON-RPC ids
 * @feeds       Streamable HTTP POST, DELETE, expiry, and shutdown lifecycle
 * @breaks      Treating socket loss as cancellation or losing cross-connection request identity violates MCP semantics and can orphan external work.
 * @invariants  Typed request ids are unique only while active within one session; initialize is never explicitly cancellable; cancellation aborts the addressed generation only; closeSession/closeAll await actual handler settlement; capacity is released only on settlement.
 * @side-effects Owns request AbortControllers and bounded in-memory active records.
 * @perf        O(1) register/cancel and O(active request count) teardown with a hard maximum.
 * @concurrency One lease owns one terminal finish; JavaScript event-loop ordering defines registration and cancellation order.
 * @test        tests/unit/streamable-http.test.ts
 * @stability   experimental MCP 2025-11-25
 * @since       2026-07-15
 */

import { randomUUID } from "node:crypto";

import type { JsonRpcRequest } from "../jsonrpc.js";

interface ActiveRequest {
  sessionId?: string;
  method: string;
  controller: AbortController;
  settlement: Promise<void>;
  resolveSettlement: () => void;
}

export interface StreamableRequestLease {
  readonly signal: AbortSignal;
  finish(): void;
}

const MAX_ACTIVE_REQUESTS = 200;

export class StreamableRequestRegistry {
  private readonly active = new Map<string, ActiveRequest>();

  register(
    sessionId: string | undefined,
    id: JsonRpcRequest["id"],
    method: string,
  ): StreamableRequestLease | Error {
    if (this.active.size >= MAX_ACTIVE_REQUESTS) {
      return new Error("Server at capacity: too many active requests");
    }
    const addressable =
      method !== "initialize" && id !== undefined
        ? requestKey(sessionId, id)
        : undefined;
    if (addressable && this.active.has(addressable)) {
      return new Error(`Duplicate active request id: ${String(id)}`);
    }
    const key = addressable ?? `anonymous:${randomUUID()}`;
    let resolveSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => {
      resolveSettlement = resolve;
    });
    const record: ActiveRequest = {
      sessionId,
      method,
      controller: new AbortController(),
      settlement,
      resolveSettlement,
    };
    this.active.set(key, record);
    let finished = false;
    return {
      signal: record.controller.signal,
      finish: (): void => {
        if (finished) return;
        finished = true;
        if (this.active.get(key) === record) this.active.delete(key);
        record.resolveSettlement();
      },
    };
  }

  cancel(sessionId: string, id: unknown): void {
    if (typeof id !== "string" && typeof id !== "number") return;
    const request = this.active.get(requestKey(sessionId, id));
    if (!request || request.method === "initialize") return;
    request.controller.abort(
      new DOMException("MCP request cancelled", "AbortError"),
    );
  }

  async closeSession(sessionId: string, reason: string): Promise<void> {
    const settlements: Promise<void>[] = [];
    for (const request of this.active.values()) {
      if (request.sessionId !== sessionId) continue;
      request.controller.abort(new DOMException(reason, "AbortError"));
      settlements.push(request.settlement);
    }
    await Promise.all(settlements);
  }

  async closeAll(reason: string): Promise<void> {
    const settlements: Promise<void>[] = [];
    for (const request of this.active.values()) {
      request.controller.abort(new DOMException(reason, "AbortError"));
      settlements.push(request.settlement);
    }
    await Promise.all(settlements);
  }

  activeCount(): number {
    return this.active.size;
  }
}

function requestKey(
  sessionId: string | undefined,
  id: string | number | null,
): string {
  return `${sessionId ?? ""}\u0000${typeof id}\u0000${String(id)}`;
}
