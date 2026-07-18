import http from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MCP_PROTOCOL_VERSION } from "../../src/constants.js";
import { buildHandler } from "../../src/mcp/handler.js";
import type { JsonRpcHandler, JsonRpcResponse } from "../../src/mcp/jsonrpc.js";
import { _test as oauthTest } from "../../src/mcp/oauth.js";
import {
  _test,
  startStreamableHttp,
  stopStreamableHttp,
} from "../../src/mcp/streamable-http.js";
import type { McpTool } from "../../src/mcp/tools.js";
import { OperationOutcomeAmbiguousError } from "../../src/transport/contained-process.js";

const { sessions, pruneStaleSessions } = _test;

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  method: string,
  path: string,
  body?: string,
  extraHeaders?: Record<string, string>,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...extraHeaders,
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    if (body) outgoing.write(body);
    outgoing.end();
  });
}

function rpc(
  port: number,
  payload: Record<string, unknown>,
  sessionId?: string,
  extraHeaders?: Record<string, string>,
): Promise<HttpResult> {
  return request(port, "POST", "/mcp", JSON.stringify(payload), {
    ...(sessionId
      ? {
          "MCP-Session-Id": sessionId,
          "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        }
      : {}),
    ...extraHeaders,
  });
}

function parse(response: HttpResult): JsonRpcResponse {
  return JSON.parse(response.body) as JsonRpcResponse;
}

const echoHandler: JsonRpcHandler = (request) => {
  if (request.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: request.id ?? null,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "test", version: "0.0.1" },
      },
    };
  }
  if (request.method === "notifications/initialized") return undefined;
  if (request.method === "tools/list") {
    return { jsonrpc: "2.0", id: request.id ?? null, result: { tools: [] } };
  }
  if (request.method === "tools/call") {
    return {
      jsonrpc: "2.0",
      id: request.id ?? null,
      result: { content: [{ type: "text", text: "ok" }] },
    };
  }
  return {
    jsonrpc: "2.0",
    id: request.id ?? null,
    error: { code: -32_601, message: "Method not found" },
  };
};

describe("Streamable HTTP transport", () => {
  let runtimePort: number | undefined;

  async function start(
    handler: JsonRpcHandler = echoHandler,
    options?: { auth?: boolean },
  ): Promise<number> {
    runtimePort = await startStreamableHttp(0, handler, options);
    return runtimePort;
  }

  async function initialize(
    port: number,
    authorization?: string,
  ): Promise<{ sessionId: string; response: JsonRpcResponse }> {
    const initialized = await rpc(
      port,
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      undefined,
      authorization ? { Authorization: authorization } : undefined,
    );
    return {
      sessionId: initialized.headers["mcp-session-id"] as string,
      response: parse(initialized),
    };
  }

  afterEach(async () => {
    if (runtimePort !== undefined) {
      await stopStreamableHttp(runtimePort, "Streamable HTTP test complete");
    }
    runtimePort = undefined;
    sessions.clear();
    oauthTest.tokens.clear();
  });

  it("serves health, CORS preflight, and bounded session initialization", async () => {
    const port = await start();
    const health = await request(port, "GET", "/health");
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({
      status: "ok",
      transport: "streamable-http",
      protocolVersion: MCP_PROTOCOL_VERSION,
    });
    expect(health.headers["access-control-allow-origin"]).toBe(
      "http://localhost",
    );

    const options = await request(port, "OPTIONS", "/mcp");
    expect(options.status).toBe(204);
    expect(options.headers["access-control-allow-headers"]).not.toContain(
      "X-MCP-Async",
    );
    const unsupportedGet = await request(port, "GET", "/mcp");
    expect(unsupportedGet.status).toBe(405);

    const initialized = await initialize(port);
    expect(initialized.sessionId).toEqual(expect.any(String));
    expect(initialized.response.result).toMatchObject({
      protocolVersion: MCP_PROTOCOL_VERSION,
    });
    expect(sessions.has(initialized.sessionId)).toBe(true);
  });

  it("rejects invalid origins, malformed JSON, and missing sessions", async () => {
    const port = await start();
    const forbidden = await rpc(
      port,
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      undefined,
      { Origin: "https://evil.example.com" },
    );
    expect(forbidden.status).toBe(403);

    const malformed = await request(port, "POST", "/mcp", "{broken");
    expect(malformed.status).toBe(400);
    expect(parse(malformed).error?.code).toBe(-32_700);

    const missingSession = await rpc(port, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    expect(missingSession.status).toBe(404);
  });

  it("enforces the negotiated protocol version", async () => {
    const port = await start();
    const { sessionId } = await initialize(port);
    const missing = await request(
      port,
      "POST",
      "/mcp",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
      { "MCP-Session-Id": sessionId },
    );
    expect(missing.status).toBe(400);
    expect(parse(missing).error?.message).toContain("Missing");

    const wrong = await request(
      port,
      "POST",
      "/mcp",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
        params: {},
      }),
      {
        "MCP-Session-Id": sessionId,
        "MCP-Protocol-Version": "1999-01-01",
      },
    );
    expect(wrong.status).toBe(400);
    expect(parse(wrong).error?.message).toContain("Unsupported");
  });

  it("accepts successful and failed notifications with an empty 202", async () => {
    let calls = 0;
    const handler: JsonRpcHandler = (message) => {
      if (message.method === "initialize") return echoHandler(message);
      calls += 1;
      if (message.method === "notifications/fail") {
        throw new Error("notification exploded");
      }
      return undefined;
    };
    const port = await start(handler);
    const { sessionId } = await initialize(port);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const successful = await rpc(
      port,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      sessionId,
    );
    const failed = await rpc(
      port,
      { jsonrpc: "2.0", method: "notifications/fail" },
      sessionId,
    );
    expect(successful).toMatchObject({ status: 202, body: "" });
    expect(failed).toMatchObject({ status: 202, body: "" });
    expect(calls).toBe(2);
    expect(stderr.mock.calls.flat().join("")).toContain(
      "notification notifications/fail failed",
    );
  });

  it("returns a single MCP response as SSE only when requested", async () => {
    const port = await start();
    const { sessionId } = await initialize(port);
    const response = await rpc(
      port,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "test", arguments: {} },
      },
      sessionId,
      { Accept: "text/event-stream" },
    );
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: message");
    expect(response.body).toContain('"id":3');
  });

  it("validates Origin on every route and protocol version before DELETE", async () => {
    const port = await start();
    const { sessionId } = await initialize(port);
    const hostile = { Origin: "https://attacker.example" };
    expect(
      (await request(port, "GET", "/health", undefined, hostile)).status,
    ).toBe(403);
    expect(
      (await request(port, "GET", "/mcp", undefined, hostile)).status,
    ).toBe(403);
    const hostileDelete = await request(port, "DELETE", "/mcp", undefined, {
      ...hostile,
      "MCP-Session-Id": sessionId,
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    });
    expect(hostileDelete.status).toBe(403);
    expect(sessions.has(sessionId)).toBe(true);

    const wrongProtocol = await request(port, "DELETE", "/mcp", undefined, {
      "MCP-Session-Id": sessionId,
      "MCP-Protocol-Version": "1999-01-01",
    });
    expect(wrongProtocol.status).toBe(400);
    expect(sessions.has(sessionId)).toBe(true);
  });

  it("cancels an addressed live request across HTTP connections", async () => {
    const started = deferred<AbortSignal>();
    const handler: JsonRpcHandler = (message, context) => {
      if (message.method === "initialize") return echoHandler(message);
      if (message.method !== "tools/call") return echoHandler(message);
      const signal = context!.signal!;
      started.resolve(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    };
    const port = await start(handler);
    const { sessionId } = await initialize(port);
    const original = rpc(
      port,
      {
        jsonrpc: "2.0",
        id: 22,
        method: "tools/call",
        params: { name: "slow", arguments: {} },
      },
      sessionId,
    );
    const signal = await started.promise;
    const cancelled = await rpc(
      port,
      {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 22, reason: "client no longer needs result" },
      },
      sessionId,
    );

    expect(cancelled).toMatchObject({ status: 202, body: "" });
    expect(signal.aborted).toBe(true);
    expect(await original).toMatchObject({ status: 202, body: "" });
  });

  it("does not reinterpret an HTTP disconnect as MCP cancellation", async () => {
    const observed = deferred<AbortSignal>();
    let effects = 0;
    const handler: JsonRpcHandler = async (message, context) => {
      if (message.method === "initialize") return echoHandler(message);
      const signal = context!.signal!;
      observed.resolve(signal);
      await new Promise((resolve) => setTimeout(resolve, 40));
      effects += 1;
      return {
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: { content: [{ type: "text", text: "settled" }] },
      };
    };
    const port = await start(handler);
    const { sessionId } = await initialize(port);
    const client = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Session-Id": sessionId,
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      },
    });
    client.on("error", () => undefined);
    client.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 23,
        method: "tools/call",
        params: { name: "read", arguments: {} },
      }),
    );
    const signal = await observed.promise;
    client.destroy();

    await vi.waitFor(() => expect(effects).toBe(1));
    expect(signal.aborted).toBe(false);
  });

  it("expires session authority before awaiting durable containment", async () => {
    const closed = deferred<void>();
    const handler: JsonRpcHandler = echoHandler;
    handler.closeSession = async (sessionId, reason) => {
      expect(sessionId).toBe("stale");
      expect(reason).toBe("MCP session expired");
      closed.resolve();
    };
    sessions.set("stale", {
      created: 0,
      lastSeen: 0,
      protocolVersion: MCP_PROTOCOL_VERSION,
    });
    sessions.set("fresh", {
      created: Date.now(),
      lastSeen: Date.now(),
      protocolVersion: MCP_PROTOCOL_VERSION,
    });

    await pruneStaleSessions(handler.closeSession);
    expect(sessions.has("stale")).toBe(false);
    expect(sessions.has("fresh")).toBe(true);
    await closed.promise;
  });

  it("runs the full standard Tasks flow through one handler-owned registry", async () => {
    const gate = deferred<ReturnType<typeof toolSuccess>>();
    const handler = buildHandler([mutatingTool(async () => gate.promise)]);
    const port = await start(handler);
    const { sessionId, response: initialized } = await initialize(port);
    expect(initialized.result).toMatchObject({
      capabilities: {
        tasks: {
          list: {},
          cancel: {},
          requests: { tools: { call: {} } },
        },
      },
    });

    const created = parse(
      await rpc(
        port,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "mutate",
            arguments: {},
            task: { ttl: 60_000 },
          },
        },
        sessionId,
      ),
    );
    const taskId = (created.result as { task: { taskId: string } }).task.taskId;
    expect(created.result).toMatchObject({
      task: { taskId, status: "working", ttl: 60_000 },
    });

    const listed = parse(
      await rpc(
        port,
        { jsonrpc: "2.0", id: 3, method: "tasks/list", params: {} },
        sessionId,
      ),
    );
    expect(listed.result).toMatchObject({
      tasks: [{ taskId, status: "working" }],
    });

    const resultRequest = rpc(
      port,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tasks/result",
        params: { taskId },
      },
      sessionId,
    );
    let didResolve = false;
    void resultRequest.then(() => {
      didResolve = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(didResolve).toBe(false);
    gate.resolve(toolSuccess("mutated"));

    const result = parse(await resultRequest);
    expect(result.result).toMatchObject({
      content: [{ type: "text", text: "mutated" }],
      _meta: { "io.modelcontextprotocol/related-task": { taskId } },
    });
    const status = parse(
      await rpc(
        port,
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tasks/get",
          params: { taskId },
        },
        sessionId,
      ),
    );
    expect(status.result).toMatchObject({ taskId, status: "completed" });
  });

  it("isolates standard tasks by session", async () => {
    const handler = buildHandler([mutatingTool(async () => toolSuccess("ok"))]);
    const port = await start(handler);
    const first = await initialize(port);
    const second = await initialize(port);
    const created = parse(
      await rpc(
        port,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "mutate", arguments: {}, task: {} },
        },
        first.sessionId,
      ),
    );
    const taskId = (created.result as { task: { taskId: string } }).task.taskId;
    const foreign = parse(
      await rpc(
        port,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tasks/get",
          params: { taskId },
        },
        second.sessionId,
      ),
    );
    expect(foreign.error).toMatchObject({
      code: -32_602,
      message: "Task not found",
    });
  });

  it("waits for cancellation settlement and preserves outcome ambiguity", async () => {
    const cancellationObserved = deferred<void>();
    const settle = deferred<void>();
    const handler = buildHandler([
      mutatingTool(
        async (_arguments, context) =>
          new Promise((_resolve, reject) => {
            const abort = (): void => {
              cancellationObserved.resolve();
              void settle.promise.then(() =>
                reject(
                  new OperationOutcomeAmbiguousError(
                    "test dispatched mutation",
                    context?.signal?.reason,
                  ),
                ),
              );
            };
            if (context?.signal?.aborted) abort();
            else
              context?.signal?.addEventListener("abort", abort, { once: true });
          }),
      ),
    ]);
    const port = await start(handler);
    const { sessionId } = await initialize(port);
    const created = parse(
      await rpc(
        port,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "mutate", arguments: {}, task: {} },
        },
        sessionId,
      ),
    );
    const taskId = (created.result as { task: { taskId: string } }).task.taskId;
    const cancellation = rpc(
      port,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tasks/cancel",
        params: { taskId },
      },
      sessionId,
    );
    await cancellationObserved.promise;
    let didResolve = false;
    void cancellation.then(() => {
      didResolve = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(didResolve).toBe(false);
    settle.resolve();

    expect(parse(await cancellation).result).toMatchObject({
      taskId,
      status: "cancelled",
      statusMessage: expect.stringContaining("ambiguous"),
    });
    const result = parse(
      await rpc(
        port,
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tasks/result",
          params: { taskId },
        },
        sessionId,
      ),
    );
    expect(result.error?.data).toMatchObject({
      outcome_ambiguous: true,
      retryable: false,
    });
  });

  it("DELETE revokes the session and waits for task containment before 204", async () => {
    const cancellationObserved = deferred<void>();
    const settle = deferred<void>();
    let effects = 0;
    const handler = buildHandler([
      mutatingTool(async (_arguments, context) =>
        new Promise((_resolve, reject) => {
          const abort = (): void => {
            cancellationObserved.resolve();
            void settle.promise.then(() => reject(context?.signal?.reason));
          };
          if (context?.signal?.aborted) abort();
          else
            context?.signal?.addEventListener("abort", abort, { once: true });
        }).then(() => {
          effects += 1;
          return toolSuccess("unexpected");
        }),
      ),
    ]);
    const port = await start(handler);
    const { sessionId } = await initialize(port);
    await rpc(
      port,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "mutate", arguments: {}, task: {} },
      },
      sessionId,
    );

    const deletion = request(port, "DELETE", "/mcp", undefined, {
      "MCP-Session-Id": sessionId,
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    });
    await cancellationObserved.promise;
    expect(sessions.has(sessionId)).toBe(false);
    let didResolve = false;
    void deletion.then(() => {
      didResolve = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(didResolve).toBe(false);
    settle.resolve();
    expect((await deletion).status).toBe(204);
    expect(effects).toBe(0);
  });

  it("awaits durable containment before server close resolves", async () => {
    const cancellationObserved = deferred<void>();
    const settle = deferred<void>();
    const handler = buildHandler([
      mutatingTool(
        async (_arguments, context) =>
          new Promise((_resolve, reject) => {
            context?.signal?.addEventListener(
              "abort",
              () => {
                cancellationObserved.resolve();
                void settle.promise.then(() => reject(context.signal?.reason));
              },
              { once: true },
            );
          }),
      ),
    ]);
    const port = await start(handler);
    const { sessionId } = await initialize(port);
    await rpc(
      port,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "mutate", arguments: {}, task: {} },
      },
      sessionId,
    );

    const closing = stopStreamableHttp(runtimePort!, "test shutdown");
    await cancellationObserved.promise;
    let didResolve = false;
    void closing.then(() => {
      didResolve = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(didResolve).toBe(false);
    settle.resolve();
    await closing;
    expect(didResolve).toBe(true);
  });

  it("binds an authenticated session to the OAuth client principal", async () => {
    oauthTest.tokens.set("client-a-token", {
      clientId: "client-a",
      expiresAt: Date.now() + 60_000,
    });
    oauthTest.tokens.set("client-b-token", {
      clientId: "client-b",
      expiresAt: Date.now() + 60_000,
    });
    const port = await start(echoHandler, { auth: true });
    const { sessionId } = await initialize(port, "Bearer client-a-token");
    const adopted = await rpc(
      port,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sessionId,
      { Authorization: "Bearer client-b-token" },
    );
    expect(adopted.status).toBe(403);
    expect(parse(adopted).error?.message).toContain(
      "different authenticated client",
    );
  });

  it("does not revive the removed X-MCP-Async task protocol", async () => {
    const handler = buildHandler([mutatingTool(async () => toolSuccess("ok"))]);
    const port = await start(handler);
    const { sessionId } = await initialize(port);
    const legacy = parse(
      await rpc(
        port,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "mutate", arguments: {} },
        },
        sessionId,
        { "X-MCP-Async": "true" },
      ),
    );
    expect(legacy.error).toMatchObject({
      code: -32_602,
      message: expect.stringContaining("requires task augmentation"),
    });
    const oldStatus = parse(
      await rpc(
        port,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tasks/status",
          params: { taskId: "legacy" },
        },
        sessionId,
      ),
    );
    expect(oldStatus.error?.code).toBe(-32_601);
  });
});

function mutatingTool(handler: McpTool["handler"]): McpTool {
  return {
    name: "mutate",
    description: "test mutation",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: false },
    execution: { taskSupport: "required" },
    handler,
  };
}

function toolSuccess(text: string) {
  return { content: [{ type: "text" as const, text }] };
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
