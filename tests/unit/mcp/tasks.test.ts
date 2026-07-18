import { describe, expect, it, vi } from "vitest";

import { buildHandler } from "../../../src/mcp/handler.js";
import type {
  JsonRpcHandler,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../../../src/mcp/jsonrpc.js";
import type { McpTool } from "../../../src/mcp/tools.js";
import { OperationOutcomeAmbiguousError } from "../../../src/transport/contained-process.js";

describe("MCP 2025-11-25 Tasks", () => {
  it("advertises task capabilities and requires durable execution for mutating tools", async () => {
    const handler = buildHandler([
      mutatingTool(async () => successResult("ok")),
    ]);

    const initialized = await call(handler, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    const listed = await call(handler, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const direct = await call(handler, toolCall(3));

    expect(initialized.result).toMatchObject({
      capabilities: {
        tasks: {
          list: {},
          cancel: {},
          requests: { tools: { call: {} } },
        },
      },
    });
    expect(listed.result).toMatchObject({
      tools: [{ name: "mutate", execution: { taskSupport: "required" } }],
    });
    expect(direct.error).toMatchObject({
      code: -32602,
      message: expect.stringContaining("requires task augmentation"),
    });
  });

  it("returns CreateTaskResult immediately and blocks tasks/result until exact completion", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = buildHandler([
      mutatingTool(async () => {
        await gate;
        return successResult("settled");
      }),
    ]);

    const created = await call(handler, taskCall(1));
    const task = taskFrom(created);
    expect(task).toMatchObject({
      status: "working",
      ttl: 60_000,
      pollInterval: expect.any(Number),
    });
    expect(Date.parse(task.createdAt as string)).not.toBeNaN();
    expect(Date.parse(task.lastUpdatedAt as string)).not.toBeNaN();

    let resultSettled = false;
    const resultPromise = call(handler, {
      jsonrpc: "2.0",
      id: 2,
      method: "tasks/result",
      params: { taskId: task.taskId },
    }).finally(() => {
      resultSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resultSettled).toBe(false);
    release();

    const result = await resultPromise;
    expect(result.result).toMatchObject({
      content: [{ type: "text", text: "settled" }],
      _meta: {
        "io.modelcontextprotocol/related-task": { taskId: task.taskId },
      },
    });
    const status = await getTask(handler, task.taskId as string, 3);
    expect(status.result).toMatchObject({ status: "completed" });
  });

  it("classifies CallToolResult isError as failed while preserving the exact result", async () => {
    const handler = buildHandler([
      mutatingTool(async () => ({
        ...successResult("ambiguous"),
        isError: true,
      })),
    ]);
    const created = await call(handler, taskCall(1));
    const taskId = taskFrom(created).taskId as string;

    await vi.waitFor(async () => {
      const status = await getTask(handler, taskId, 2);
      expect(status.result).toMatchObject({ status: "failed" });
    });
    const result = await call(handler, {
      jsonrpc: "2.0",
      id: 3,
      method: "tasks/result",
      params: { taskId },
    });
    expect(result.result).toMatchObject({
      isError: true,
      content: [{ text: "ambiguous" }],
    });
  });

  it("waits for cancellation settlement and exposes structural ambiguity through tasks/result", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const handler = buildHandler([
      mutatingTool(
        (_args, context) =>
          new Promise((_resolve, reject) => {
            markStarted();
            const signal = context?.signal;
            signal?.addEventListener(
              "abort",
              () =>
                reject(
                  new OperationOutcomeAmbiguousError(
                    "fixture mutation",
                    signal.reason,
                  ),
                ),
              { once: true },
            );
          }),
      ),
    ]);
    const created = await call(handler, taskCall(1));
    const taskId = taskFrom(created).taskId as string;
    await started;

    const cancelled = await call(handler, {
      jsonrpc: "2.0",
      id: 2,
      method: "tasks/cancel",
      params: { taskId },
    });
    expect(cancelled.result).toMatchObject({
      taskId,
      status: "cancelled",
      statusMessage: expect.stringContaining("ambiguous external outcome"),
    });
    const result = await call(handler, {
      jsonrpc: "2.0",
      id: 3,
      method: "tasks/result",
      params: { taskId },
    });
    expect(result.error).toMatchObject({
      code: -32603,
      data: {
        outcome_ambiguous: true,
        retryable: false,
        operation: "fixture mutation",
      },
    });
    const repeatedCancel = await call(handler, {
      jsonrpc: "2.0",
      id: 4,
      method: "tasks/cancel",
      params: { taskId },
    });
    expect(repeatedCancel.error?.code).toBe(-32602);
  });

  it("contains a synchronous task handler throw and keeps session ownership isolated", async () => {
    const handler = buildHandler([
      mutatingTool(() => {
        throw new Error("synchronous fixture failure");
      }),
    ]);
    const created = await call(handler, taskCall(1), "session-a");
    const taskId = taskFrom(created).taskId as string;

    await vi.waitFor(async () => {
      const status = await getTask(handler, taskId, 2, "session-a");
      expect(status.result).toMatchObject({ status: "failed" });
    });
    const foreign = await getTask(handler, taskId, 3, "session-b");
    expect(foreign.error).toMatchObject({
      code: -32602,
      message: "Task not found",
    });
    const listed = await call(
      handler,
      { jsonrpc: "2.0", id: 4, method: "tasks/list", params: {} },
      "session-a",
    );
    expect(listed.result).toMatchObject({
      tasks: [{ taskId, status: "failed" }],
    });
  });
});

function mutatingTool(handler: NonNullable<McpTool["handler"]>): McpTool {
  return {
    name: "mutate",
    description: "Mutate fixture state",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: false },
    handler,
  };
}

function successResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function toolCall(id: number): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "mutate", arguments: {} },
  };
}

function taskCall(id: number): JsonRpcRequest {
  return {
    ...toolCall(id),
    params: { name: "mutate", arguments: {}, task: { ttl: 60_000 } },
  };
}

function taskFrom(response: JsonRpcResponse): Record<string, unknown> {
  return (response.result as { task: Record<string, unknown> }).task;
}

function getTask(
  handler: JsonRpcHandler,
  taskId: string,
  id: number,
  sessionId = "test-session",
): Promise<JsonRpcResponse> {
  return call(
    handler,
    { jsonrpc: "2.0", id, method: "tasks/get", params: { taskId } },
    sessionId,
  );
}

async function call(
  handler: JsonRpcHandler,
  request: JsonRpcRequest,
  sessionId = "test-session",
): Promise<JsonRpcResponse> {
  const response = await handler(request, {
    transport: "mcp-stdio",
    mcpSessionId: sessionId,
  });
  if (!response) throw new Error(`Missing response for ${request.method}`);
  return response;
}
