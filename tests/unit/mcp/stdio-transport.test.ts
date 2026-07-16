import { PassThrough, Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type {
  JsonRpcHandler,
  JsonRpcResponse,
} from "../../../src/mcp/jsonrpc.js";
import {
  MCP_STDIO_MAX_FRAME_BYTES,
  startStdioTransport,
} from "../../../src/mcp/stdio-transport.js";

describe("MCP stdio request lifecycle", () => {
  it("aborts an unsettled ordinary request without publishing a response", async () => {
    const aborted = deferred<void>();
    const handler: JsonRpcHandler = (request, context) =>
      new Promise((_resolve, reject) => {
        context?.signal?.addEventListener(
          "abort",
          () => {
            aborted.resolve();
            reject(context.signal?.reason);
          },
          { once: true },
        );
      });
    const fixture = startFixture(handler);
    fixture.write(request(1));
    fixture.write({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 1 },
    });

    await aborted.promise;
    expect(fixture.responses()).toEqual([]);
    await fixture.close();
  });

  it("cancels only the addressed request and never publishes its stale result", async () => {
    const firstGate = deferred<JsonRpcResponse>();
    const secondGate = deferred<JsonRpcResponse>();
    const signals = new Map<number, AbortSignal>();
    const handler: JsonRpcHandler = (request, context) => {
      signals.set(Number(request.id), context!.signal!);
      return request.id === 1 ? firstGate.promise : secondGate.promise;
    };
    const fixture = startFixture(handler);
    fixture.write(request(1));
    fixture.write(request(2));
    await vi.waitFor(() => expect(signals.size).toBe(2));

    fixture.write({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 1, reason: "client stopped task" },
    });
    await vi.waitFor(() => expect(signals.get(1)?.aborted).toBe(true));
    expect(signals.get(2)?.aborted).toBe(false);
    firstGate.resolve(success(1, "stale"));
    secondGate.resolve(success(2, "live"));

    await vi.waitFor(() => expect(fixture.responses()).toHaveLength(1));
    expect(fixture.responses()).toEqual([success(2, "live")]);
    fixture.write({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 2 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(signals.get(2)?.aborted).toBe(false);
    await fixture.close();
  });

  it("does not cancel initialization", async () => {
    const gate = deferred<JsonRpcResponse>();
    let signal: AbortSignal | undefined;
    const fixture = startFixture((rpc, context) => {
      signal = context?.signal;
      return gate.promise;
    });
    fixture.write({ jsonrpc: "2.0", id: 7, method: "initialize" });
    fixture.write({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 7 },
    });

    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(signal?.aborted).toBe(false);
    gate.resolve(success(7, "initialized"));
    await vi.waitFor(() => expect(fixture.responses()).toHaveLength(1));
    expect(fixture.responses()).toEqual([success(7, "initialized")]);
    await fixture.close();
  });

  it("rejects duplicate live ids but permits reuse after generation cleanup", async () => {
    const firstGate = deferred<JsonRpcResponse>();
    let calls = 0;
    const handler: JsonRpcHandler = (request) => {
      calls += 1;
      return calls === 1
        ? firstGate.promise
        : success(request.id ?? null, calls);
    };
    const fixture = startFixture(handler);
    fixture.write(request("same"));
    fixture.write(request("same"));

    await vi.waitFor(() => expect(fixture.responses()).toHaveLength(1));
    expect(fixture.responses()[0]).toEqual({
      jsonrpc: "2.0",
      id: "same",
      error: {
        code: -32_600,
        message: "Duplicate active request id: same",
      },
    });
    expect(calls).toBe(1);
    firstGate.resolve(success("same", 1));
    await vi.waitFor(() => expect(fixture.responses()).toHaveLength(2));
    fixture.write(request("same"));
    await vi.waitFor(() => expect(fixture.responses()).toHaveLength(3));
    expect(calls).toBe(2);
    expect(fixture.responses()[2]).toEqual(success("same", 2));
    await fixture.close();
  });

  it("aborts every live request when stdin closes", async () => {
    const observedSignals: AbortSignal[] = [];
    const handler: JsonRpcHandler = (_request, context) => {
      const signal = context!.signal!;
      observedSignals.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    };
    const fixture = startFixture(handler);
    fixture.write(request(1));
    fixture.write(request(2));
    await vi.waitFor(() => expect(observedSignals).toHaveLength(2));

    await fixture.close();

    expect(observedSignals.every((signal) => signal.aborted)).toBe(true);
    expect(fixture.responses()).toEqual([]);
  });

  it("publishes synchronous fulfillment authoritatively before stdin close", async () => {
    const fixture = startFixture((rpc) => success(rpc.id ?? null, "settled"));
    fixture.write(request(9));

    await fixture.close();

    expect(fixture.responses()).toEqual([success(9, "settled")]);
  });

  it("awaits durable task containment before declaring stdin drained", async () => {
    const closeGate = deferred<void>();
    const handler: JsonRpcHandler = (rpc) => success(rpc.id ?? null, "created");
    handler.closeSession = async (sessionId, reason) => {
      expect(sessionId).toBe("test-stdio-session");
      expect(reason).toBe("MCP stdio input closed");
      await closeGate.promise;
    };
    const fixture = startFixture(handler);
    fixture.write(request(10));
    await vi.waitFor(() => expect(fixture.responses()).toHaveLength(1));

    const closing = fixture.close();
    let drained = false;
    void closing.then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(drained).toBe(false);
    closeGate.resolve();
    await closing;
    expect(drained).toBe(true);
  });

  it("treats output failure as session loss and awaits containment", async () => {
    const input = new PassThrough();
    const closeGate = deferred<void>();
    const closeObserved = deferred<void>();
    const drained = deferred<void>();
    const handler: JsonRpcHandler = (rpc) =>
      success(rpc.id ?? null, "unpublishable");
    handler.closeSession = async () => {
      closeObserved.resolve();
      await closeGate.promise;
    };
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("stdout pipe closed"));
      },
    });
    startStdioTransport(handler, {
      input,
      output,
      mcpSessionId: "lost-output-session",
      onDrained: () => drained.resolve(),
    });

    input.write(`${JSON.stringify(request(11))}\n`);
    await closeObserved.promise;
    let didDrain = false;
    void drained.promise.then(() => {
      didDrain = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(didDrain).toBe(false);
    closeGate.resolve();
    await drained.promise;
    expect(didDrain).toBe(true);
  });

  it("rejects every non-object or malformed envelope before handler dispatch", async () => {
    let calls = 0;
    const fixture = startFixture(() => {
      calls += 1;
      return success(null, "unexpected");
    });
    const invalidFrames = [
      "null",
      "[]",
      "1",
      "{}",
      JSON.stringify({ jsonrpc: "1.0", id: 1, method: "ping" }),
      JSON.stringify({ jsonrpc: "2.0", id: true, method: "ping" }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "" }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: [] }),
    ];
    for (const frame of invalidFrames) fixture.writeRaw(`${frame}\n`);

    await vi.waitFor(() =>
      expect(fixture.responses()).toHaveLength(invalidFrames.length),
    );
    expect(calls).toBe(0);
    expect(fixture.responses()).toEqual(
      invalidFrames.map(() => ({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32_600, message: "Invalid Request" },
      })),
    );
    await fixture.close();
  });

  it("bounds an oversized frame and resumes on the next newline", async () => {
    const fixture = startFixture((rpc) =>
      success(rpc.id ?? null, "still-alive"),
    );
    fixture.writeRaw(`${"x".repeat(MCP_STDIO_MAX_FRAME_BYTES + 1)}\n`);
    fixture.write(request(42));

    await vi.waitFor(() => expect(fixture.responses()).toHaveLength(2));
    expect(fixture.responses()).toEqual([
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32_600, message: "Request too large" },
      },
      success(42, "still-alive"),
    ]);
    await fixture.close();
  });
});

function startFixture(handler: JsonRpcHandler) {
  const input = new PassThrough();
  const output = new PassThrough();
  const responses: JsonRpcResponse[] = [];
  let buffered = "";
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (line) responses.push(JSON.parse(line) as JsonRpcResponse);
    }
  });
  const drained = deferred<void>();
  startStdioTransport(handler, {
    input,
    output,
    mcpSessionId: "test-stdio-session",
    onDrained: () => drained.resolve(),
  });
  return {
    write(value: object): void {
      input.write(`${JSON.stringify(value)}\n`);
    },
    writeRaw(value: string): void {
      input.write(value);
    },
    responses: () => structuredClone(responses),
    async close(): Promise<void> {
      input.end();
      await drained.promise;
    },
  };
}

function request(id: number | string): object {
  return { jsonrpc: "2.0", id, method: "ping" };
}

function success(id: number | string | null, value: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result: value };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
