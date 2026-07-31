import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ModernMcpTaskManager } from "../../../src/mcp/modern-tasks.js";
import type {
  ModernMcpDetailedTask,
  ModernMcpTaskListener,
} from "../../../src/mcp/modern-tasks.js";
import { McpSubscriptionManager } from "../../../src/mcp/subscriptions.js";
import type { JsonRpcServerMessage } from "../../../src/mcp/jsonrpc.js";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ModernMcpTaskManager shutdown containment", () => {
  it("does not recover a stale lease while its owning process is still live", async () => {
    const directory = await mkdtemp(join(tmpdir(), "unicli-task-live-lease-"));
    directories.push(directory);
    const taskId = randomUUID();
    const workerId = randomUUID();
    const now = new Date().toISOString();
    const workerDirectory = join(directory, "workers");
    await mkdir(workerDirectory, { recursive: true });
    await writeFile(
      join(directory, `${taskId}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        taskId,
        status: "working",
        statusMessage: "still running",
        createdAt: now,
        lastUpdatedAt: now,
        ttlMs: 60_000,
        pollIntervalMs: 500,
        workerId,
        usedInputKeys: [],
      })}\n`,
    );
    const leasePath = join(workerDirectory, `${workerId}.json`);
    await writeFile(
      leasePath,
      `${JSON.stringify({ workerId, pid: process.pid, refreshedAt: now })}\n`,
    );
    const stale = new Date(Date.now() - 60_000);
    await utimes(leasePath, stale, stale);

    const observer = new ModernMcpTaskManager({ directory });
    const task = await observer.get(1, undefined, taskId);

    expect(task.result).toMatchObject({
      status: "working",
      statusMessage: "still running",
    });
    await observer.closeAll("test complete");
  });

  it("prunes expired records and their unused lock directories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "unicli-task-prune-"));
    directories.push(directory);
    const manager = new ModernMcpTaskManager({
      directory,
      ttlMs: 1,
      maxRetainedTasks: 1,
    });
    for (let index = 0; index < 10; index += 1) {
      await manager.create({
        requestId: index,
        transport: "mcp-http",
        execute: async () => ({
          jsonrpc: "2.0",
          id: index,
          result: { content: [{ type: "text", text: String(index) }] },
        }),
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await expect
      .poll(async () => {
        const taskFiles = (await readdir(directory)).filter((name) =>
          name.endsWith(".json"),
        );
        const lockRoots = await readdir(join(directory, "locks"));
        return { taskFiles, lockRoots };
      })
      .toEqual({ taskFiles: [], lockRoots: [] });
    await manager.closeAll("test complete");
  });

  it("snapshots terminal task state after subscription indexing without losing the transition", async () => {
    const directory = await mkdtemp(join(tmpdir(), "unicli-task-subscribe-"));
    directories.push(directory);
    const manager = new ModernMcpTaskManager({ directory });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const created = await manager.create({
      requestId: 1,
      transport: "mcp-http",
      execute: async () => {
        await gate;
        return {
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "settled" }] },
        };
      },
    });
    const taskId = (created.result as { taskId: string }).taskId;
    const select = manager.selectObservableTaskIds.bind(manager);
    manager.selectObservableTaskIds = async (...args) => {
      const selected = await select(...args);
      release();
      await expect
        .poll(async () => {
          const task = await manager.get(2, undefined, taskId);
          return (task.result as { status?: string }).status;
        })
        .toBe("completed");
      return selected;
    };
    const subscriptions = new McpSubscriptionManager(manager);
    const emitted: JsonRpcServerMessage[] = [];
    const controller = new AbortController();
    const listening = subscriptions.listen({
      request: {
        jsonrpc: "2.0",
        id: 20,
        method: "subscriptions/listen",
        params: { notifications: { taskIds: [taskId] } },
      },
      emit: (message) => {
        emitted.push(message);
        if (
          "method" in message &&
          message.method === "notifications/tasks" &&
          (message.params as { status?: string }).status === "completed"
        ) {
          controller.abort(new DOMException("observed", "AbortError"));
        }
      },
      signal: controller.signal,
      tasksExtensionEnabled: true,
    });

    await listening;
    expect(
      emitted.map((message) => ("method" in message ? message.method : "")),
    ).toEqual([
      "notifications/subscriptions/acknowledged",
      "notifications/tasks",
    ]);
    expect(emitted[1]).toMatchObject({
      params: { taskId, status: "completed" },
    });
    subscriptions.dispose();
    await manager.closeAll("test complete");
  });

  it("preserves a same-millisecond live input_required event over a stale working snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "unicli-task-same-ms-"));
    directories.push(directory);
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const manager = new ModernMcpTaskManager({ directory });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const created = await manager.create({
      requestId: 1,
      transport: "mcp-http",
      execute: async (_taskId, context) => {
        await gate;
        await context.task?.requestInput("approval", {
          method: "elicitation/create",
          params: { message: "Approve" },
        });
        return {
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "approved" }] },
        };
      },
    });
    const taskId = (created.result as { taskId: string }).taskId;
    const read = manager.readObservableTasks.bind(manager);
    manager.readObservableTasks = async (...args) => {
      const stale = await read(...args);
      release();
      await expect
        .poll(async () => {
          const current = await manager.get(2, undefined, taskId);
          return (current.result as { status?: string }).status;
        })
        .toBe("input_required");
      return stale;
    };

    const subscriptions = new McpSubscriptionManager(manager);
    const emitted: JsonRpcServerMessage[] = [];
    const controller = new AbortController();
    const listening = subscriptions.listen({
      request: {
        jsonrpc: "2.0",
        id: 20,
        method: "subscriptions/listen",
        params: { notifications: { taskIds: [taskId] } },
      },
      emit: (message) => {
        emitted.push(message);
        if (
          "method" in message &&
          message.method === "notifications/tasks" &&
          (message.params as { status?: string }).status === "input_required"
        ) {
          controller.abort(new DOMException("observed", "AbortError"));
        }
      },
      signal: controller.signal,
      tasksExtensionEnabled: true,
    });

    await listening;
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toMatchObject({
      method: "notifications/tasks",
      params: { taskId, status: "input_required" },
    });
    subscriptions.dispose();
    await manager.closeAll("test complete");
  });

  it("coalesces same-task updates while a subscription transport is slow", async () => {
    const taskId = randomUUID();
    let publish!: ModernMcpTaskListener;
    const fakeTasks = {
      subscribe(listener: ModernMcpTaskListener) {
        publish = listener;
        return () => undefined;
      },
      selectObservableTaskIds: async (ids: string[]) => ids,
      readObservableTasks: async () => [] as ModernMcpDetailedTask[],
    } as unknown as ModernMcpTaskManager;
    const subscriptions = new McpSubscriptionManager(fakeTasks);
    const emitted: JsonRpcServerMessage[] = [];
    let releaseFirstTask!: () => void;
    const firstTaskGate = new Promise<void>((resolve) => {
      releaseFirstTask = resolve;
    });
    let acknowledge!: () => void;
    const acknowledged = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const controller = new AbortController();
    let taskMessages = 0;
    const listening = subscriptions.listen({
      request: {
        jsonrpc: "2.0",
        id: 21,
        method: "subscriptions/listen",
        params: { notifications: { taskIds: [taskId] } },
      },
      emit: async (message) => {
        emitted.push(message);
        if (
          "method" in message &&
          message.method === "notifications/subscriptions/acknowledged"
        ) {
          acknowledge();
          return;
        }
        taskMessages += 1;
        if (taskMessages === 1) await firstTaskGate;
        if (
          "method" in message &&
          (message.params as { statusMessage?: string }).statusMessage ===
            "update-100"
        ) {
          controller.abort(new DOMException("observed", "AbortError"));
        }
      },
      signal: controller.signal,
      tasksExtensionEnabled: true,
    });
    await acknowledged;
    const base = {
      taskId,
      status: "working" as const,
      createdAt: "2026-07-30T00:00:00.000Z",
      lastUpdatedAt: "2026-07-30T00:00:00.000Z",
      ttlMs: 60_000,
    };
    publish({ ...base, statusMessage: "update-0" });
    await expect.poll(() => taskMessages).toBe(1);
    for (let index = 1; index <= 100; index += 1) {
      publish({ ...base, statusMessage: `update-${index}` });
    }
    releaseFirstTask();
    await listening;

    const taskEvents = emitted.filter(
      (message) =>
        "method" in message && message.method === "notifications/tasks",
    );
    expect(taskEvents).toHaveLength(2);
    expect(taskEvents[1]).toMatchObject({
      params: { taskId, statusMessage: "update-100" },
    });
    subscriptions.dispose();
  });

  it("waits for execution settlement when a tool ignores cancellation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "unicli-task-settlement-"));
    directories.push(directory);
    const manager = new ModernMcpTaskManager({ directory });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const created = await manager.create({
      requestId: 1,
      transport: "mcp-http",
      execute: async () => {
        await gate;
        return {
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "settled" }] },
        };
      },
    });
    const taskId = (created.result as { taskId: string }).taskId;
    let closed = false;
    const closing = manager.closeAll("server stopping").then(() => {
      closed = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    release();
    await closing;
    expect(closed).toBe(true);
    const task = await manager.get(2, undefined, taskId);
    expect(task.result).toMatchObject({
      status: "completed",
      result: { content: [{ type: "text", text: "settled" }] },
    });
  });

  it("rejects cross-worker input updates instead of acknowledging a lost wakeup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "unicli-task-affinity-"));
    directories.push(directory);
    const owner = new ModernMcpTaskManager({ directory });
    let requested!: () => void;
    const inputRequested = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const created = await owner.create({
      requestId: 1,
      transport: "mcp-http",
      execute: async (_taskId, context) => {
        requested();
        await context.task?.requestInput("approval", {
          method: "elicitation/create",
          params: {
            message: "Approve",
            requestedSchema: {
              type: "object",
              properties: { approved: { type: "boolean" } },
              required: ["approved"],
            },
          },
        });
        return {
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "approved" }] },
        };
      },
    });
    const taskId = (created.result as { taskId: string }).taskId;
    await inputRequested;
    await expect
      .poll(async () => {
        const view = await owner.get(3, undefined, taskId);
        return (view.result as { status?: string }).status;
      })
      .toBe("input_required");
    const otherWorker = new ModernMcpTaskManager({ directory });
    const update = await otherWorker.update(2, undefined, taskId, {
      approval: { approved: true },
    });

    expect(update.error).toMatchObject({
      code: -32603,
      data: {
        reason: "worker_misroute",
        taskId,
        retryable: true,
      },
    });
    await otherWorker.closeAll("test complete");
    await owner.closeAll("test complete");
  });

  it("quarantines a malformed durable record without disabling the manager", async () => {
    const directory = await mkdtemp(join(tmpdir(), "unicli-task-corrupt-"));
    directories.push(directory);
    const taskId = "123e4567-e89b-42d3-a456-426614174000";
    const now = new Date().toISOString();
    await writeFile(
      join(directory, `${taskId}.json`),
      JSON.stringify({
        schemaVersion: 1,
        taskId,
        status: "completed",
        createdAt: now,
        lastUpdatedAt: now,
        ttlMs: 60_000,
        pollIntervalMs: 500,
        usedInputKeys: [],
      }),
    );

    const manager = new ModernMcpTaskManager({ directory });
    await expect(manager.get(1, undefined, taskId)).rejects.toMatchObject({
      code: "mcp_task_store_corrupt",
      path: join(directory, `${taskId}.json`),
    });
    const created = await manager.create({
      requestId: 2,
      transport: "mcp-http",
      execute: async () => ({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: "healthy" }] },
      }),
    });
    expect(created.result).toMatchObject({ resultType: "task" });
    expect(
      (await readdir(directory)).some((name) =>
        name.startsWith(`${taskId}.json.corrupt.`),
      ),
    ).toBe(true);
    await manager.closeAll("test complete");
  });
});
