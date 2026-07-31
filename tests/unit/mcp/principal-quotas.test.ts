import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MCP_PROTOCOL_VERSION } from "../../../src/constants.js";
import { buildHandler } from "../../../src/mcp/handler.js";
import type {
  JsonRpcResponse,
  McpRequestContext,
} from "../../../src/mcp/jsonrpc.js";
import { ModernMcpTaskManager } from "../../../src/mcp/modern-tasks.js";
import { _test as oauthTest } from "../../../src/mcp/oauth.js";
import {
  _test as streamableHttpTest,
  startStreamableHttp,
  stopStreamableHttp,
} from "../../../src/mcp/streamable-http.js";

const TASKS_PER_PRINCIPAL = 32;
const GLOBAL_TASK_LIMIT = 200;
const SESSIONS_PER_PRINCIPAL = 25;
const GLOBAL_SESSION_LIMIT = 100;

const temporaryDirectories: string[] = [];
let streamablePort: number | undefined;

afterEach(async () => {
  if (streamablePort !== undefined) {
    await stopStreamableHttp(streamablePort, "principal quota test complete");
  }
  streamablePort = undefined;
  streamableHttpTest.sessions.clear();
  oauthTest.tokens.clear();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("MCP per-principal quotas", () => {
  it("reserves task capacity atomically, admits another principal, and releases both completed and cancelled tasks", async () => {
    const manager = await createManager("unicli-task-principal-quota-");
    const firstTask = deferred<void>();
    try {
      const attempts = await Promise.all(
        Array.from({ length: TASKS_PER_PRINCIPAL + 1 }, (_, index) =>
          manager.create({
            requestId: index,
            principalId: "client-a",
            transport: "mcp-http",
            execute:
              index === 0
                ? async () => {
                    await firstTask.promise;
                    return taskSuccess(index);
                  }
                : heldUntilCancelled,
          }),
        ),
      );
      const created = attempts.filter(isTaskResponse);
      const rejected = attempts.filter((response) => response.error);
      expect(created).toHaveLength(TASKS_PER_PRINCIPAL);
      expect(rejected).toEqual([
        expect.objectContaining({
          error: {
            code: -32_603,
            message: "Principal at capacity: too many active tasks",
          },
        }),
      ]);

      const otherPrincipal = await manager.create({
        requestId: 101,
        principalId: "client-b",
        transport: "mcp-http",
        execute: heldUntilCancelled,
      });
      expect(otherPrincipal).toSatisfy(isTaskResponse);

      const completedTaskId = taskId(
        created.find((response) => response.id === 0)!,
      );
      firstTask.resolve();
      await expect
        .poll(async () => taskStatus(manager, "client-a", completedTaskId))
        .toBe("completed");

      const replacement = await manager.create({
        requestId: 102,
        principalId: "client-a",
        transport: "mcp-http",
        execute: heldUntilCancelled,
      });
      expect(replacement).toSatisfy(isTaskResponse);

      const replacementTaskId = taskId(replacement);
      await manager.cancel(103, "client-a", replacementTaskId);
      await expect
        .poll(async () => taskStatus(manager, "client-a", replacementTaskId))
        .toBe("cancelled");

      expect(
        await manager.create({
          requestId: 104,
          principalId: "client-a",
          transport: "mcp-http",
          execute: heldUntilCancelled,
        }),
      ).toSatisfy(isTaskResponse);
    } finally {
      firstTask.resolve();
      await manager.closeAll("principal quota test complete");
    }
  });

  it("enforces the global task ceiling after distributing work below every principal ceiling, then releases it", async () => {
    const manager = await createManager("unicli-task-global-quota-");
    try {
      const attempts = await Promise.all(
        Array.from({ length: GLOBAL_TASK_LIMIT + 1 }, (_, index) =>
          manager.create({
            requestId: index,
            principalId: `client-${Math.floor(
              index / (TASKS_PER_PRINCIPAL - 1),
            )}`,
            transport: "mcp-http",
            execute: heldUntilCancelled,
          }),
        ),
      );
      const created = attempts.filter(isTaskResponse);
      const rejected = attempts.filter((response) => response.error);
      expect(created).toHaveLength(GLOBAL_TASK_LIMIT);
      expect(rejected).toEqual([
        expect.objectContaining({
          error: {
            code: -32_603,
            message: "Server at capacity: too many active tasks",
          },
        }),
      ]);

      const releasedTaskId = taskId(
        created.find((response) => response.id === 0)!,
      );
      await manager.cancel(201, "client-0", releasedTaskId);
      await expect
        .poll(async () => taskStatus(manager, "client-0", releasedTaskId))
        .toBe("cancelled");
      expect(
        await manager.create({
          requestId: 202,
          principalId: "fresh-client",
          transport: "mcp-http",
          execute: heldUntilCancelled,
        }),
      ).toSatisfy(isTaskResponse);
    } finally {
      await manager.closeAll("global quota test complete");
    }
  }, 30_000);

  it("returns distinct principal and global session capacity errors without letting one principal monopolize admission", async () => {
    streamablePort = await startStreamableHttp(0, buildHandler([]), {
      auth: true,
    });
    const resource = `http://127.0.0.1:${streamablePort}/mcp`;
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
    const now = Date.now();
    for (let index = 0; index < SESSIONS_PER_PRINCIPAL; index += 1) {
      addSession(`client-a-${index}`, now, "client-a");
    }

    const principalLimited = await initialize("client-a-token", 1);
    expect(principalLimited.status).toBe(429);
    expect(principalLimited.body.error).toMatchObject({
      code: -32_603,
      message: "Principal at capacity: too many active sessions",
    });

    const fairAdmission = await initialize("client-b-token", 2);
    expect(fairAdmission.status).toBe(200);
    expect(fairAdmission.sessionId).toEqual(expect.any(String));

    streamableHttpTest.sessions.delete("client-a-0");
    const releasedAdmission = await initialize("client-a-token", 3);
    expect(releasedAdmission.status).toBe(200);

    streamableHttpTest.sessions.clear();
    for (let index = 0; index < GLOBAL_SESSION_LIMIT; index += 1) {
      addSession(`global-${index}`, now, `owner-${index}`);
    }
    const globallyLimited = await initialize("client-b-token", 4);
    expect(globallyLimited.status).toBe(503);
    expect(globallyLimited.body.error).toMatchObject({
      code: -32_603,
      message: "Server at capacity: too many active sessions",
    });
    expect(streamableHttpTest.sessions.size).toBe(GLOBAL_SESSION_LIMIT);
  });
});

async function createManager(prefix: string): Promise<ModernMcpTaskManager> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return new ModernMcpTaskManager({ directory });
}

function heldUntilCancelled(
  _taskId: string,
  context: McpRequestContext,
): Promise<JsonRpcResponse> {
  return new Promise((_resolve, reject) => {
    if (context.signal?.aborted) {
      reject(context.signal.reason);
      return;
    }
    context.signal?.addEventListener(
      "abort",
      () => reject(context.signal?.reason),
      { once: true },
    );
  });
}

function taskSuccess(id: number): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: "complete" }] },
  };
}

function isTaskResponse(response: JsonRpcResponse): boolean {
  return (
    typeof response.result === "object" &&
    response.result !== null &&
    "resultType" in response.result &&
    response.result.resultType === "task"
  );
}

function taskId(response: JsonRpcResponse): string {
  return (response.result as { taskId: string }).taskId;
}

async function taskStatus(
  manager: ModernMcpTaskManager,
  principalId: string,
  id: string,
): Promise<unknown> {
  const response = await manager.get(999, principalId, id);
  return (response.result as { status?: unknown } | undefined)?.status;
}

function addSession(id: string, now: number, principalId: string): void {
  streamableHttpTest.sessions.set(id, {
    created: now,
    lastSeen: now,
    protocolVersion: MCP_PROTOCOL_VERSION,
    principalId,
  });
}

async function initialize(
  token: string,
  id: number,
): Promise<{
  status: number;
  sessionId: string | undefined;
  body: JsonRpcResponse;
}> {
  const response = await post(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {},
    }),
    { Authorization: `Bearer ${token}` },
  );
  return {
    status: response.status,
    sessionId: response.headers["mcp-session-id"] as string | undefined,
    body: JSON.parse(response.body) as JsonRpcResponse,
  };
}

function post(
  body: string,
  headers: Record<string, string>,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        hostname: "127.0.0.1",
        port: streamablePort,
        path: "/mcp",
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value?: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return {
    promise,
    resolve(value?: T) {
      resolve(value as T);
    },
  };
}
