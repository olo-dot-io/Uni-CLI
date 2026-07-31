import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
} from "../../../src/constants.js";
import { buildHandler } from "../../../src/mcp/handler.js";
import type {
  JsonRpcHandler,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../../../src/mcp/jsonrpc.js";
import type { McpTool } from "../../../src/mcp/tools.js";

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": MCP_MODERN_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientInfo": {
    name: "protocol-test",
    version: "1.0.0",
  },
  "io.modelcontextprotocol/clientCapabilities": {},
} as const;

describe("MCP 2026-07-28 dual-era protocol", () => {
  let taskStoreDirectory: string;
  const handlers: JsonRpcHandler[] = [];

  beforeEach(async () => {
    taskStoreDirectory = await mkdtemp(
      join(tmpdir(), "unicli-mcp-modern-tasks-"),
    );
  });

  afterEach(async () => {
    await Promise.all(
      handlers.map((handler) => handler.closeAll?.("test teardown")),
    );
    handlers.length = 0;
    await rm(taskStoreDirectory, { recursive: true, force: true });
  });

  it("discovers modern and legacy revisions without initialization", async () => {
    const handler = makeHandler([tool()]);
    const response = await call(handler, modernRequest(1, "server/discover"));

    expect(response.result).toMatchObject({
      resultType: "complete",
      supportedVersions: [MCP_MODERN_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION],
      capabilities: {
        tools: {},
        extensions: {
          "io.modelcontextprotocol/tasks": {},
        },
      },
      ttlMs: expect.any(Number),
      cacheScope: "public",
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: "unicli",
          version: expect.any(String),
        },
      },
    });
  });

  it("requires per-request modern metadata and reports supported revisions", async () => {
    const handler = makeHandler([tool()]);
    const missingCapabilities = await call(handler, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion":
            MCP_MODERN_PROTOCOL_VERSION,
        },
      },
    });
    const unsupported = await call(handler, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {
        _meta: {
          ...MODERN_META,
          "io.modelcontextprotocol/protocolVersion": "1900-01-01",
        },
      },
    });

    expect(missingCapabilities.error).toMatchObject({
      code: -32602,
      message: expect.stringContaining("clientCapabilities"),
    });
    expect(unsupported.error).toMatchObject({
      code: -32022,
      data: {
        requested: "1900-01-01",
        supported: [MCP_MODERN_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION],
      },
    });
  });

  it("returns cacheable deterministic tool lists without legacy task metadata", async () => {
    const handler = makeHandler([tool()]);
    const response = await call(handler, modernRequest(1, "tools/list"));

    expect(response.result).toMatchObject({
      resultType: "complete",
      tools: [{ name: "mutate" }],
      ttlMs: 300_000,
      cacheScope: "public",
    });
    const listed = response.result as {
      tools: Array<{ execution?: unknown }>;
    };
    expect(listed.tools[0]?.execution).toBeUndefined();
  });

  it("requires the Tasks extension when the server selects durable execution", async () => {
    const handlerFn = vi.fn(() => ({
      content: [{ type: "text" as const, text: "done" }],
    }));
    const handler = makeHandler([tool(handlerFn)]);
    const response = await call(
      handler,
      modernRequest(1, "tools/call", {
        name: "mutate",
        arguments: {},
      }),
    );

    expect(handlerFn).not.toHaveBeenCalled();
    expect(response.error).toMatchObject({
      code: -32021,
      data: {
        requiredCapabilities: {
          extensions: {
            "io.modelcontextprotocol/tasks": {},
          },
        },
      },
    });
  });

  it("lets an optional tool select sync or durable execution per call without a client task hint", async () => {
    const optional: McpTool = {
      name: "optional-work",
      description: "Choose execution mode from owned arguments",
      inputSchema: {
        type: "object",
        properties: { slow: { type: "boolean" } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execution: { taskSupport: "optional" },
      selectModernTask: (args) => (args.slow === true ? "task" : "sync"),
      handler: () => ({
        content: [{ type: "text", text: "done" }],
      }),
    };
    const handler = makeHandler([optional]);

    const fast = await call(
      handler,
      modernTaskRequest(1, "tools/call", {
        name: optional.name,
        arguments: { slow: false },
      }),
    );
    const slow = await call(
      handler,
      modernTaskRequest(2, "tools/call", {
        name: optional.name,
        arguments: { slow: true },
      }),
    );
    const unsupportedClient = await call(
      handler,
      modernRequest(3, "tools/call", {
        name: optional.name,
        arguments: { slow: true },
      }),
    );
    const listed = await call(handler, modernRequest(4, "tools/list"));

    expect(fast.result).toMatchObject({ resultType: "complete" });
    expect(slow.result).toMatchObject({
      resultType: "task",
      status: "working",
    });
    expect(unsupportedClient.result).toMatchObject({
      resultType: "complete",
    });
    expect(
      (listed.result as { tools: Array<Record<string, unknown>> }).tools[0],
    ).not.toHaveProperty("selectModernTask");
  });

  it("lets the server create a flat durable task and returns the exact final tool result", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handlerFn = vi.fn(async () => {
      await gate;
      return {
        content: [{ type: "text" as const, text: "done" }],
        isError: true,
      };
    });
    const handler = makeHandler([tool(handlerFn)]);
    const created = await call(
      handler,
      modernTaskRequest(1, "tools/call", {
        name: "mutate",
        arguments: {},
      }),
    );
    const task = resultRecord(created);

    expect(task).toMatchObject({
      resultType: "task",
      taskId: expect.any(String),
      status: "working",
      ttlMs: expect.any(Number),
      pollIntervalMs: expect.any(Number),
    });
    expect(task.task).toBeUndefined();
    const immediate = await getTask(handler, task.taskId as string, 2);
    expect(immediate.result).toMatchObject({
      resultType: "complete",
      taskId: task.taskId,
      status: "working",
    });

    release();
    await vi.waitFor(async () => {
      const completed = await getTask(handler, task.taskId as string, 3);
      expect(completed.result).toMatchObject({
        status: "completed",
        result: {
          content: [{ type: "text", text: "done" }],
          isError: true,
        },
      });
    });
    expect(handlerFn).toHaveBeenCalledTimes(1);
  });

  it("persists terminal tasks across handler instances", async () => {
    const first = makeHandler([tool()]);
    const created = await call(
      first,
      modernTaskRequest(1, "tools/call", {
        name: "mutate",
        arguments: {},
      }),
    );
    const taskId = resultRecord(created).taskId as string;
    await vi.waitFor(async () => {
      expect((await getTask(first, taskId, 2)).result).toMatchObject({
        status: "completed",
      });
    });

    const second = makeHandler([tool()]);
    const restored = await getTask(second, taskId, 3);
    expect(restored.result).toMatchObject({
      resultType: "complete",
      taskId,
      status: "completed",
      result: { content: [{ type: "text", text: "ok" }] },
    });
  });

  it("round-trips task input without reusing or exposing stale requests", async () => {
    const handler = makeHandler([
      tool(async (_args, context) => {
        const response = await context?.task?.requestInput("approval-1", {
          method: "elicitation/create",
          params: { message: "Approve fixture mutation?" },
        });
        return {
          content: [
            {
              type: "text" as const,
              text: String(response?.action ?? "missing"),
            },
          ],
        };
      }),
    ]);
    const created = await call(
      handler,
      modernTaskRequest(1, "tools/call", {
        name: "mutate",
        arguments: {},
      }),
    );
    const taskId = resultRecord(created).taskId as string;

    await vi.waitFor(async () => {
      expect((await getTask(handler, taskId, 2)).result).toMatchObject({
        status: "input_required",
        inputRequests: {
          "approval-1": {
            method: "elicitation/create",
          },
        },
      });
    });
    const updated = await call(
      handler,
      modernTaskRequest(3, "tasks/update", {
        taskId,
        inputResponses: {
          "unknown-key": { action: "ignored" },
          "approval-1": { action: "accept" },
        },
      }),
    );
    expect(updated.result).toMatchObject({ resultType: "complete" });
    await vi.waitFor(async () => {
      expect((await getTask(handler, taskId, 4)).result).toMatchObject({
        status: "completed",
        result: {
          content: [{ type: "text", text: "accept" }],
        },
      });
    });
  });

  it("acknowledges cooperative cancellation before observable settlement", async () => {
    const handler = makeHandler([
      tool(
        (_args, context) =>
          new Promise((_resolve, reject) => {
            context?.signal?.addEventListener(
              "abort",
              () => reject(context.signal?.reason),
              { once: true },
            );
          }),
      ),
    ]);
    const created = await call(
      handler,
      modernTaskRequest(1, "tools/call", {
        name: "mutate",
        arguments: {},
      }),
    );
    const taskId = resultRecord(created).taskId as string;
    const cancelled = await call(
      handler,
      modernTaskRequest(2, "tasks/cancel", { taskId }),
    );

    expect(cancelled.result).toMatchObject({ resultType: "complete" });
    expect(resultRecord(cancelled).status).toBeUndefined();
    await vi.waitFor(async () => {
      expect((await getTask(handler, taskId, 3)).result).toMatchObject({
        status: "cancelled",
      });
    });
  });

  it("binds authenticated tasks to their creating principal", async () => {
    const handler = makeHandler([tool()]);
    const created = await call(
      handler,
      modernTaskRequest(1, "tools/call", {
        name: "mutate",
        arguments: {},
      }),
      "principal-a",
    );
    const taskId = resultRecord(created).taskId as string;
    const foreign = await getTask(handler, taskId, 2, "principal-b");
    expect(foreign.error).toMatchObject({
      code: -32602,
      message: "Task not found",
    });
  });

  it("acknowledges task subscriptions first and pushes complete task state", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = makeHandler([
      tool(async () => {
        await gate;
        return { content: [{ type: "text" as const, text: "notified" }] };
      }),
    ]);
    const created = await call(
      handler,
      modernTaskRequest(1, "tools/call", {
        name: "mutate",
        arguments: {},
      }),
    );
    const taskId = resultRecord(created).taskId as string;
    const emitted: JsonRpcNotification[] = [];
    const controller = new AbortController();
    const listening = handler(
      modernTaskRequest(20, "subscriptions/listen", {
        notifications: { taskIds: [taskId] },
      }),
      {
        transport: "mcp-stdio",
        signal: controller.signal,
        emit: (message) => {
          if ("method" in message) emitted.push(message);
        },
      },
    );

    await vi.waitFor(() => {
      expect(emitted[0]).toMatchObject({
        method: "notifications/subscriptions/acknowledged",
        params: {
          _meta: {
            "io.modelcontextprotocol/subscriptionId": 20,
          },
          notifications: { taskIds: [taskId] },
        },
      });
    });
    release();
    await vi.waitFor(() => {
      expect(
        emitted.find(
          (message) =>
            message.method === "notifications/tasks" &&
            (message.params as { status?: string }).status === "completed",
        ),
      ).toMatchObject({
        method: "notifications/tasks",
        params: {
          taskId,
          status: "completed",
          result: {
            content: [{ type: "text", text: "notified" }],
          },
          _meta: {
            "io.modelcontextprotocol/subscriptionId": 20,
          },
        },
      });
    });
    controller.abort(new DOMException("test complete", "AbortError"));
    await listening;
    expect(emitted[0]?.method).toBe("notifications/subscriptions/acknowledged");
  });

  it("rejects invalid or oversized task subscription filters before opening a stream", async () => {
    const handler = makeHandler([tool()]);
    const invalid = await handler(
      modernTaskRequest(20, "subscriptions/listen", {
        notifications: { taskIds: ["not-a-task-id"] },
      }),
      { transport: "mcp-stdio", emit: () => undefined },
    );
    const oversized = await handler(
      modernTaskRequest(21, "subscriptions/listen", {
        notifications: {
          taskIds: Array.from(
            { length: 501 },
            () => "00000000-0000-4000-8000-000000000000",
          ),
        },
      }),
      { transport: "mcp-stdio", emit: () => undefined },
    );

    expect(invalid.error).toMatchObject({
      code: -32602,
      message: "taskIds entries must be UUIDv4 task identifiers",
    });
    expect(oversized.error).toMatchObject({
      code: -32602,
      message: "taskIds must contain at most 500 entries",
    });
  });

  it("keeps removed legacy core methods out of the modern surface", async () => {
    const handler = makeHandler([tool()]);
    const ping = await call(handler, modernRequest(1, "ping"));
    const legacyTask = await call(
      handler,
      modernTaskRequest(2, "tasks/result", { taskId: "legacy-task" }),
    );

    expect(ping.error).toMatchObject({ code: -32601 });
    expect(legacyTask.error).toMatchObject({ code: -32601 });
  });

  function makeHandler(tools: McpTool[]): JsonRpcHandler {
    const handler = buildHandler(tools, [], {
      modernTaskStoreDirectory: taskStoreDirectory,
    });
    handlers.push(handler);
    return handler;
  }
});

function modernRequest(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: { ...params, _meta: params._meta ?? MODERN_META },
  };
}

function modernTaskRequest(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): JsonRpcRequest {
  const capabilities =
    MODERN_META["io.modelcontextprotocol/clientCapabilities"];
  return modernRequest(id, method, {
    ...params,
    _meta: {
      ...MODERN_META,
      "io.modelcontextprotocol/clientCapabilities": {
        ...capabilities,
        extensions: {
          "io.modelcontextprotocol/tasks": {},
        },
      },
    },
  });
}

function tool(
  handler: NonNullable<McpTool["handler"]> = () => ({
    content: [{ type: "text", text: "ok" }],
  }),
): McpTool {
  return {
    name: "mutate",
    description: "Mutate a fixture",
    inputSchema: { type: "object", additionalProperties: false },
    annotations: { readOnlyHint: false },
    execution: { taskSupport: "required" },
    handler,
  };
}

async function call(
  handler: JsonRpcHandler,
  request: JsonRpcRequest,
  principalId?: string,
): Promise<JsonRpcResponse> {
  const response = await handler(request, {
    transport: "mcp-stdio",
    mcpSessionId: "protocol-2026-test",
    ...(principalId ? { principalId } : {}),
  });
  expect(response).toBeDefined();
  return response!;
}

function resultRecord(response: JsonRpcResponse): Record<string, unknown> {
  return response.result as Record<string, unknown>;
}

function getTask(
  handler: JsonRpcHandler,
  taskId: string,
  id: number,
  principalId?: string,
): Promise<JsonRpcResponse> {
  return call(
    handler,
    modernTaskRequest(id, "tasks/get", { taskId }),
    principalId,
  );
}
