import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
} from "../../src/constants.js";
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

function modernPayload(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
  protocolVersion = MCP_MODERN_PROTOCOL_VERSION,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": protocolVersion,
        "io.modelcontextprotocol/clientInfo": {
          name: "streamable-http-test",
          version: "1.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
}

function modernTaskPayload(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): Record<string, unknown> {
  const payload = modernPayload(id, method, params);
  const payloadParams = payload.params as Record<string, unknown>;
  const meta = payloadParams._meta as Record<string, unknown>;
  meta["io.modelcontextprotocol/clientCapabilities"] = {
    extensions: {
      "io.modelcontextprotocol/tasks": {},
    },
  };
  return payload;
}

function modernRpc(
  port: number,
  payload: Record<string, unknown>,
): Promise<HttpResult> {
  const params = payload.params as Record<string, unknown> | undefined;
  const meta = params?._meta as Record<string, unknown> | undefined;
  const headers: Record<string, string> = {
    "MCP-Protocol-Version": String(
      meta?.["io.modelcontextprotocol/protocolVersion"] ??
        MCP_MODERN_PROTOCOL_VERSION,
    ),
    "Mcp-Method": String(payload.method),
  };
  if (payload.method === "tools/call" || payload.method === "prompts/get") {
    headers["Mcp-Name"] = String(params?.name ?? "");
  } else if (
    payload.method === "tasks/get" ||
    payload.method === "tasks/update" ||
    payload.method === "tasks/cancel"
  ) {
    headers["Mcp-Name"] = String(params?.taskId ?? "");
  } else if (payload.method === "resources/read") {
    headers["Mcp-Name"] = String(params?.uri ?? "");
  }
  return rpc(port, payload, undefined, headers);
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
  const temporaryDirectories: string[] = [];

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
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
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

  it("serves stateless modern discovery without minting a session", async () => {
    const port = await start(buildHandler([]));
    const response = await modernRpc(
      port,
      modernPayload(10, "server/discover"),
    );
    const body = parse(response);

    expect(response.status).toBe(200);
    expect(response.headers["mcp-session-id"]).toBeUndefined();
    expect(response.headers["mcp-protocol-version"]).toBe(
      MCP_MODERN_PROTOCOL_VERSION,
    );
    expect(body.result).toMatchObject({
      resultType: "complete",
      supportedVersions: [MCP_MODERN_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION],
      cacheScope: "public",
    });
    expect(sessions.size).toBe(0);
  });

  it("validates modern mirrored headers and protocol versions", async () => {
    const port = await start(buildHandler([]));
    const missingMeta = await rpc(
      port,
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/list",
        params: {},
      },
      undefined,
      {
        "MCP-Protocol-Version": MCP_MODERN_PROTOCOL_VERSION,
        "Mcp-Method": "tools/list",
      },
    );
    const missingMethod = await rpc(
      port,
      modernPayload(11, "tools/list"),
      undefined,
      {
        "MCP-Protocol-Version": MCP_MODERN_PROTOCOL_VERSION,
      },
    );
    const unsupported = await rpc(
      port,
      modernPayload(12, "tools/list", {}, "1900-01-01"),
      undefined,
      {
        "MCP-Protocol-Version": "1900-01-01",
        "Mcp-Method": "tools/list",
      },
    );

    expect(missingMeta.status).toBe(400);
    expect(parse(missingMeta).error).toMatchObject({ code: -32602 });
    expect(missingMethod.status).toBe(400);
    expect(parse(missingMethod).error).toMatchObject({ code: -32020 });
    expect(unsupported.status).toBe(400);
    expect(parse(unsupported).error).toMatchObject({
      code: -32022,
      data: {
        requested: "1900-01-01",
        supported: [MCP_MODERN_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION],
      },
    });
  });

  it("returns modern method errors as HTTP 404", async () => {
    const port = await start(buildHandler([]));
    const response = await modernRpc(port, modernPayload(13, "unknown/method"));

    expect(response.status).toBe(404);
    expect(parse(response).error).toMatchObject({ code: -32601 });
  });

  it("returns missing Tasks capability as HTTP 400 before JSON or SSE success", async () => {
    const port = await start(
      buildHandler([mutatingTool(async () => toolSuccess("must not run"))]),
    );
    const payload = modernPayload(14, "tools/call", {
      name: "mutate",
      arguments: {},
    });
    const json = await modernRpc(port, payload);
    const sse = await rpc(port, payload, undefined, {
      Accept: "text/event-stream",
      "MCP-Protocol-Version": MCP_MODERN_PROTOCOL_VERSION,
      "Mcp-Method": "tools/call",
      "Mcp-Name": "mutate",
    });

    expect(json.status).toBe(400);
    expect(sse.status).toBe(400);
    expect(json.headers["content-type"]).toContain("application/json");
    expect(sse.headers["content-type"]).toContain("application/json");
    expect(parse(json).error).toMatchObject({ code: -32021 });
    expect(parse(sse).error).toMatchObject({ code: -32021 });
  });

  it("compares Mcp-Name as an exact standard header without parameter decoding", async () => {
    const port = await start(
      buildHandler([
        {
          name: "abc",
          description: "Exact-name probe",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
          handler: () => toolSuccess("matched"),
        },
      ]),
    );
    const payload = modernPayload(15, "tools/call", {
      name: "abc",
      arguments: {},
    });

    for (const encoded of ["=?base64?YWJj?=", "=base64YWJj="]) {
      const response = await rpc(port, payload, undefined, {
        "MCP-Protocol-Version": MCP_MODERN_PROTOCOL_VERSION,
        "Mcp-Method": "tools/call",
        "Mcp-Name": encoded,
      });
      expect(response.status).toBe(400);
      expect(parse(response).error).toMatchObject({ code: -32020 });
    }
  });

  it("treats a closed modern response stream as request cancellation", async () => {
    const observed = deferred<AbortSignal>();
    const handler = buildHandler([
      {
        name: "slow_read",
        description: "Wait until the response stream closes",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
        handler: async (_args, context) => {
          const signal = context!.signal!;
          observed.resolve(signal);
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
          return toolSuccess("unreachable");
        },
      },
    ]);
    const port = await start(handler);
    const payload = modernPayload(14, "tools/call", {
      name: "slow_read",
      arguments: {},
    });
    const client = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "MCP-Protocol-Version": MCP_MODERN_PROTOCOL_VERSION,
        "Mcp-Method": "tools/call",
        "Mcp-Name": "slow_read",
      },
    });
    client.on("error", () => undefined);
    client.end(JSON.stringify(payload));
    const signal = await observed.promise;
    client.destroy();

    await vi.waitFor(() => expect(signal.aborted).toBe(true));
  });

  it("runs modern durable tasks statelessly with task-addressed routing headers", async () => {
    const taskStoreDirectory = await mkdtemp(
      join(tmpdir(), "unicli-streamable-modern-tasks-"),
    );
    temporaryDirectories.push(taskStoreDirectory);
    const gate = deferred<ReturnType<typeof toolSuccess>>();
    const handler = buildHandler([mutatingTool(async () => gate.promise)], [], {
      modernTaskStoreDirectory: taskStoreDirectory,
    });
    const port = await start(handler);

    const created = parse(
      await modernRpc(
        port,
        modernTaskPayload(15, "tools/call", {
          name: "mutate",
          arguments: {},
        }),
      ),
    );
    const taskId = (created.result as { taskId: string }).taskId;
    expect(created.result).toMatchObject({
      resultType: "task",
      taskId,
      status: "working",
    });

    const mismatchedHeader = await rpc(
      port,
      modernTaskPayload(16, "tasks/get", { taskId }),
      undefined,
      {
        "MCP-Protocol-Version": MCP_MODERN_PROTOCOL_VERSION,
        "Mcp-Method": "tasks/get",
        "Mcp-Name": "wrong-task",
      },
    );
    expect(mismatchedHeader.status).toBe(400);
    expect(parse(mismatchedHeader).error).toMatchObject({ code: -32020 });

    const working = parse(
      await modernRpc(port, modernTaskPayload(17, "tasks/get", { taskId })),
    );
    expect(working.result).toMatchObject({
      resultType: "complete",
      taskId,
      status: "working",
    });

    gate.resolve(toolSuccess("settled"));
    await vi.waitFor(async () => {
      const completed = parse(
        await modernRpc(port, modernTaskPayload(18, "tasks/get", { taskId })),
      );
      expect(completed.result).toMatchObject({
        status: "completed",
        result: {
          content: [{ type: "text", text: "settled" }],
        },
      });
    });
    expect(sessions.size).toBe(0);
  });

  it("streams acknowledged task subscriptions and closes them gracefully", async () => {
    const taskStoreDirectory = await mkdtemp(
      join(tmpdir(), "unicli-streamable-subscriptions-"),
    );
    temporaryDirectories.push(taskStoreDirectory);
    const gate = deferred<ReturnType<typeof toolSuccess>>();
    const handler = buildHandler([mutatingTool(async () => gate.promise)], [], {
      modernTaskStoreDirectory: taskStoreDirectory,
    });
    const port = await start(handler);
    const created = parse(
      await modernRpc(
        port,
        modernTaskPayload(30, "tools/call", {
          name: "mutate",
          arguments: {},
        }),
      ),
    );
    const taskId = (created.result as { taskId: string }).taskId;
    const messages: Array<Record<string, unknown>> = [];
    const acknowledged = deferred<void>();
    const taskNotification = deferred<void>();
    const ended = deferred<void>();
    let buffered = "";
    const payload = modernTaskPayload(31, "subscriptions/listen", {
      notifications: { taskIds: [taskId] },
    });
    const client = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": MCP_MODERN_PROTOCOL_VERSION,
          "Mcp-Method": "subscriptions/listen",
        },
      },
      (incoming) => {
        expect(incoming.statusCode).toBe(200);
        expect(incoming.headers["content-type"]).toContain("text/event-stream");
        expect(incoming.headers["x-accel-buffering"]).toBe("no");
        incoming.on("data", (chunk: Buffer) => {
          buffered += chunk.toString("utf8");
          const events = buffered.split("\n\n");
          buffered = events.pop() ?? "";
          for (const event of events) {
            const data = event
              .split("\n")
              .find((line) => line.startsWith("data: "));
            if (!data) continue;
            const message = JSON.parse(data.slice(6)) as Record<
              string,
              unknown
            >;
            messages.push(message);
            if (message.method === "notifications/subscriptions/acknowledged") {
              acknowledged.resolve();
            }
            if (
              message.method === "notifications/tasks" &&
              (message.params as { status?: string }).status === "completed"
            ) {
              taskNotification.resolve();
            }
          }
        });
        incoming.on("end", () => ended.resolve());
      },
    );
    client.on("error", () => undefined);
    client.end(JSON.stringify(payload));

    await acknowledged.promise;
    expect(messages[0]).toMatchObject({
      method: "notifications/subscriptions/acknowledged",
      params: {
        notifications: { taskIds: [taskId] },
        _meta: { "io.modelcontextprotocol/subscriptionId": 31 },
      },
    });
    gate.resolve(toolSuccess("streamed"));
    await taskNotification.promise;
    expect(
      messages.find(
        (message) =>
          message.method === "notifications/tasks" &&
          (message.params as { status?: string }).status === "completed",
      ),
    ).toMatchObject({
      method: "notifications/tasks",
      params: {
        taskId,
        status: "completed",
        result: { content: [{ type: "text", text: "streamed" }] },
      },
    });

    const closing = stopStreamableHttp(port, "subscription test complete");
    await ended.promise;
    await closing;
    runtimePort = undefined;
    expect(messages.at(-1)).toMatchObject({
      id: 31,
      result: {
        resultType: "complete",
        _meta: { "io.modelcontextprotocol/subscriptionId": 31 },
      },
    });
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
    const port = await start(echoHandler, { auth: true });
    const resource = `http://127.0.0.1:${port}/mcp`;
    oauthTest.putToken("client-a-token", {
      clientId: "client-a",
      resource,
      expiresAt: Date.now() + 60_000,
    });
    oauthTest.putToken("client-b-token", {
      clientId: "client-b",
      resource,
      expiresAt: Date.now() + 60_000,
    });
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
