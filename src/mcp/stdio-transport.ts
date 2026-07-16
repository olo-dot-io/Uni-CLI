/**
 * @owner       src/mcp/stdio-transport.ts
 * @does        Serve bounded concurrent newline-delimited MCP JSON-RPC over stdio with spec-compliant request cancellation, durable-task teardown, validation, and output backpressure.
 * @needs       node:crypto, node:events, src/mcp/jsonrpc.ts
 * @feeds       src/mcp/server.ts
 * @breaks      Responding to a cancelled ordinary request or exiting before durable tasks settle violates MCP lifecycle semantics and can lose or replay external mutations.
 * @invariants  Frames are byte-bounded before allocation growth; every request validates before field access and owns one generation/AbortController; notifications/cancelled never cancels initialize and emits no response for work cancelled before observed settlement; synchronous fulfillment is authoritative; completed ids are reusable; stdin close or stdout failure stops intake, aborts live requests, and awaits handler session containment; writes are serialized and await drain.
 * @side-effects Reads newline-delimited JSON, writes JSON-RPC responses, aborts request-local controllers, and closes the handler session on input teardown.
 * @perf        O(frame bytes) decoding, O(1) active-request lookup, and one JSON serialization per response.
 * @concurrency Requests overlap while one write queue preserves complete frames and honors output backpressure; generation-checked cleanup cannot delete a newer reused id.
 * @test        tests/unit/mcp/stdio-transport.test.ts, tests/unit/mcp-server.test.ts
 * @stability   stable
 * @since       2026-07-15
 */

import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import {
  jsonRpcError,
  parseJsonRpcRequestText,
  type JsonRpcHandler,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./jsonrpc.js";

interface StdioTransportOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  mcpSessionId?: string;
  onDrained?: () => void;
}

interface ActiveRequest {
  controller: AbortController;
  generation: number;
  method: string;
}

export interface StdioTransport {
  close(): void;
}

export const MCP_STDIO_MAX_FRAME_BYTES = 1_048_576;
export function startStdioTransport(
  handler: JsonRpcHandler,
  options: StdioTransportOptions = {},
): StdioTransport {
  const input = options.input ?? process.stdin;
  const inputEvents = input as unknown as EventEmitter;
  const output = options.output ?? process.stdout;
  const mcpSessionId = options.mcpSessionId ?? randomUUID();
  const onDrained = options.onDrained ?? (() => process.exit(0));
  const activeRequests = new Map<string, ActiveRequest>();
  const activeControllers = new Set<AbortController>();
  const frameChunks: Buffer[] = [];
  let frameBytes = 0;
  let discardingOversizedFrame = false;
  let nextGeneration = 0;
  let pendingRequests = 0;
  let pendingWrites = 0;
  let pendingSessionClose = 0;
  let inputClosed = false;
  let writeTail = Promise.resolve();

  const exitIfDrained = (): void => {
    if (
      inputClosed &&
      pendingRequests === 0 &&
      pendingWrites === 0 &&
      pendingSessionClose === 0
    )
      onDrained();
  };
  const beginShutdown = (reason: Error): void => {
    if (inputClosed) return;
    inputClosed = true;
    inputEvents.off("data", onData);
    input.pause();
    for (const controller of activeControllers) controller.abort(reason);
    pendingSessionClose += 1;
    void Promise.resolve()
      .then(() => handler.closeSession?.(mcpSessionId, reason.message))
      .catch((error: unknown) => {
        process.stderr.write(
          `MCP stdio session teardown failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      })
      .finally(() => {
        pendingSessionClose -= 1;
        exitIfDrained();
      });
    exitIfDrained();
  };
  const send = (response: JsonRpcResponse): void => {
    const payload = `${JSON.stringify(response)}\n`;
    pendingWrites += 1;
    writeTail = writeTail
      .then(() => writeWithBackpressure(output, payload))
      .catch((error: unknown) => {
        const reason =
          error instanceof Error ? error : new Error(String(error));
        beginShutdown(reason);
      })
      .finally(() => {
        pendingWrites -= 1;
        exitIfDrained();
      });
  };

  const dispatchFrame = (frame: Buffer): void => {
    const text = stripTrailingCarriageReturn(frame).toString("utf8").trim();
    if (!text) return;
    const decoded = parseJsonRpcRequestText(text);
    if (!decoded.ok) {
      send(decoded.response);
      return;
    }
    const request = decoded.request;
    if (request.method === "notifications/cancelled") {
      cancelActiveRequest(request, activeRequests);
      return;
    }

    const hasRequestId = Object.hasOwn(request, "id");
    const requestId = request.id ?? null;
    const key = hasRequestId ? requestKey(requestId) : undefined;
    if (key && activeRequests.has(key)) {
      send(
        jsonRpcError(
          requestId,
          -32_600,
          `Duplicate active request id: ${String(requestId)}`,
        ),
      );
      return;
    }

    const controller = new AbortController();
    const generation = ++nextGeneration;
    if (key) {
      activeRequests.set(key, {
        controller,
        generation,
        method: request.method,
      });
    }
    activeControllers.add(controller);
    pendingRequests += 1;
    const finish = (): void => {
      if (key) {
        const active = activeRequests.get(key);
        if (active?.generation === generation) activeRequests.delete(key);
      }
      activeControllers.delete(controller);
      pendingRequests -= 1;
      exitIfDrained();
    };
    const completion = dispatchRequest(
      handler,
      request,
      hasRequestId,
      requestId,
      controller,
      mcpSessionId,
      send,
    );
    if (completion) void completion.finally(finish);
    else finish();
  };

  const onData = (value: string | Buffer): void => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);
      if (discardingOversizedFrame) {
        if (newline === -1) return;
        discardingOversizedFrame = false;
        offset = newline + 1;
        continue;
      }
      if (frameBytes + segment.length > MCP_STDIO_MAX_FRAME_BYTES) {
        frameChunks.length = 0;
        frameBytes = 0;
        send(jsonRpcError(null, -32_600, "Request too large"));
        if (newline === -1) {
          discardingOversizedFrame = true;
          return;
        }
        offset = newline + 1;
        continue;
      }
      if (segment.length > 0) {
        frameChunks.push(segment);
        frameBytes += segment.length;
      }
      if (newline === -1) return;
      dispatchFrame(Buffer.concat(frameChunks, frameBytes));
      frameChunks.length = 0;
      frameBytes = 0;
      offset = newline + 1;
    }
  };

  const onClose = (): void => {
    if (inputClosed) return;
    if (!discardingOversizedFrame && frameBytes > 0) {
      dispatchFrame(Buffer.concat(frameChunks, frameBytes));
    }
    frameChunks.length = 0;
    frameBytes = 0;
    const reason = new DOMException("MCP stdio input closed", "AbortError");
    beginShutdown(reason);
  };

  inputEvents.on("data", onData);
  inputEvents.once("end", onClose);
  inputEvents.once("close", onClose);
  input.resume();

  return {
    close(): void {
      inputEvents.off("data", onData);
      onClose();
    },
  };
}

function dispatchRequest(
  handler: JsonRpcHandler,
  request: JsonRpcRequest,
  hasRequestId: boolean,
  requestId: JsonRpcResponse["id"],
  controller: AbortController,
  mcpSessionId: string,
  send: (response: JsonRpcResponse) => void,
): Promise<void> | undefined {
  const publishResponse = (response: JsonRpcResponse | undefined): void => {
    if (hasRequestId && !controller.signal.aborted && response) send(response);
  };
  const publishError = (error: unknown): void => {
    if (!hasRequestId || controller.signal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    send(jsonRpcError(requestId, -32_603, `Internal error: ${message}`));
  };

  let response:
    | JsonRpcResponse
    | undefined
    | Promise<JsonRpcResponse | undefined>;
  try {
    response = handler(request, {
      transport: "mcp-stdio",
      mcpSessionId,
      signal: controller.signal,
    });
  } catch (error) {
    publishError(error);
    return undefined;
  }
  if (isPromiseLike(response)) {
    return Promise.resolve(response).then(publishResponse, publishError);
  }
  publishResponse(response);
  return undefined;
}

function cancelActiveRequest(
  request: JsonRpcRequest,
  activeRequests: ReadonlyMap<string, ActiveRequest>,
): void {
  const requestId = request.params?.requestId;
  if (typeof requestId !== "string" && typeof requestId !== "number") return;
  const active = activeRequests.get(requestKey(requestId));
  if (!active || active.method === "initialize") return;
  active.controller.abort(
    new DOMException("MCP request cancelled", "AbortError"),
  );
}

function requestKey(id: JsonRpcRequest["id"]): string {
  return id === null || id === undefined
    ? "null"
    : `${typeof id}:${String(id)}`;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as PromiseLike<T>).then === "function"
  );
}

function stripTrailingCarriageReturn(frame: Buffer): Buffer {
  return frame.at(-1) === 0x0d ? frame.subarray(0, -1) : frame;
}

function writeWithBackpressure(
  output: NodeJS.WritableStream,
  payload: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      output.off("drain", finish);
      output.off("error", fail);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    output.once("error", fail);
    const accepted = output.write(payload);
    if (accepted) finish();
    else output.once("drain", finish);
  });
}
