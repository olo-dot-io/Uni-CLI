/**
 * @owner       src::mcp::tasks
 * @does        Own the transport-independent MCP 2025-11-25 durable task state machine, session isolation, cancellation settlement, pagination, and exact result retrieval.
 * @needs       node:crypto, shared JSON-RPC contracts, structural outcome-ambiguity errors
 * @feeds       MCP handler across stdio and Streamable HTTP transports
 * @breaks      Losing a task or releasing active capacity before its operation settles can hide or replay an external mutation.
 * @invariants  Tasks begin working; task ids are receiver-generated/session-scoped; terminal status never changes; cancellation responds only after settlement; tasks/result blocks until settlement and returns the exact underlying result/error; isError tool results fail the task; active and retained state are bounded.
 * @side-effects Owns request-scoped AbortControllers and an in-memory bounded task registry.
 * @perf        O(1) get/cancel/result lookup; task listing and retention pruning are O(task count) with a hard bound.
 * @concurrency JavaScript settlement order is authoritative; each task has one terminal transition and one settlement promise.
 * @test        tests/unit/mcp/tasks.test.ts, tests/unit/mcp/stdio-transport.test.ts, tests/unit/streamable-http.test.ts
 * @stability   experimental MCP 2025-11-25
 * @since       2026-07-15
 */

import { randomUUID } from "node:crypto";

import { findOperationOutcomeAmbiguousError } from "../transport/contained-process.js";
import {
  jsonRpcError,
  type JsonRpcResponse,
  type McpRequestContext,
} from "./jsonrpc.js";

export type McpTaskStatus =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled";

export interface McpTaskView {
  taskId: string;
  status: McpTaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttl: number | null;
  pollInterval?: number;
}

interface McpTaskRecord extends McpTaskView {
  sessionId: string;
  createdAtMs: number;
  lastUpdatedAtMs: number;
  controller: AbortController;
  settled: boolean;
  removeOnSettlement: boolean;
  response?: JsonRpcResponse;
  settlement: Promise<void>;
  resolveSettlement: () => void;
}

export interface CreateMcpTaskInput {
  requestId: JsonRpcResponse["id"];
  sessionId: string;
  requestedTtl?: number;
  execute: (
    taskId: string,
    context: McpRequestContext,
  ) => JsonRpcResponse | undefined | Promise<JsonRpcResponse | undefined>;
  transport: McpRequestContext["transport"];
}

const DEFAULT_TASK_TTL_MS = 300_000;
const MIN_TASK_TTL_MS = 1_000;
const MAX_TASK_TTL_MS = 86_400_000;
const TASK_POLL_INTERVAL_MS = 250;
const MAX_ACTIVE_TASKS = 200;
const MAX_RETAINED_TASKS = 200;
const TASK_PAGE_SIZE = 50;
const REQUEST_CANCELLED = -32_800;

export class McpTaskManager {
  private readonly tasks = new Map<string, McpTaskRecord>();

  create(input: CreateMcpTaskInput): JsonRpcResponse {
    this.prune();
    if (this.activeCount() >= MAX_ACTIVE_TASKS) {
      return jsonRpcError(
        input.requestId,
        -32_603,
        "Server at capacity: too many active tasks",
      );
    }
    const ttl = normalizeTtl(input.requestedTtl);
    if (ttl === undefined) {
      return jsonRpcError(
        input.requestId,
        -32_602,
        "Task ttl must be a positive finite integer in milliseconds",
      );
    }

    const taskId = randomUUID();
    const now = Date.now();
    let resolveSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => {
      resolveSettlement = resolve;
    });
    const task: McpTaskRecord = {
      taskId,
      sessionId: input.sessionId,
      status: "working",
      statusMessage: "The operation is now in progress.",
      createdAt: iso(now),
      lastUpdatedAt: iso(now),
      createdAtMs: now,
      lastUpdatedAtMs: now,
      ttl,
      pollInterval: TASK_POLL_INTERVAL_MS,
      controller: new AbortController(),
      settled: false,
      removeOnSettlement: false,
      settlement,
      resolveSettlement,
    };
    this.tasks.set(taskId, task);

    void Promise.resolve()
      .then(() => {
        task.controller.signal.throwIfAborted();
        return input.execute(taskId, {
          transport: input.transport,
          mcpSessionId: input.sessionId,
          signal: task.controller.signal,
        });
      })
      .then(
        (response) => this.settleResponse(task, response),
        (error: unknown) => this.settleError(task, error),
      );

    return {
      jsonrpc: "2.0",
      id: input.requestId,
      result: { task: taskView(task) },
    };
  }

  get(
    id: JsonRpcResponse["id"],
    sessionId: string,
    taskId: unknown,
  ): JsonRpcResponse {
    this.prune();
    const task = this.find(sessionId, taskId);
    if (task instanceof Error) return invalidTask(id, task.message);
    return { jsonrpc: "2.0", id, result: taskView(task) };
  }

  async result(
    id: JsonRpcResponse["id"],
    sessionId: string,
    taskId: unknown,
    signal?: AbortSignal,
  ): Promise<JsonRpcResponse> {
    this.prune();
    const task = this.find(sessionId, taskId);
    if (task instanceof Error) return invalidTask(id, task.message);
    await waitForSettlement(task.settlement, signal);
    const response = task.response;
    if (!response) {
      return jsonRpcError(id, -32_603, "Task settled without a result");
    }
    if (response.error) {
      return { jsonrpc: "2.0", id, error: response.error };
    }
    return {
      jsonrpc: "2.0",
      id,
      result: withRelatedTask(response.result, task.taskId),
    };
  }

  async cancel(
    id: JsonRpcResponse["id"],
    sessionId: string,
    taskId: unknown,
  ): Promise<JsonRpcResponse> {
    this.prune();
    const task = this.find(sessionId, taskId);
    if (task instanceof Error) return invalidTask(id, task.message);
    if (isTerminal(task.status)) {
      return invalidTask(id, `Task is already ${task.status}`);
    }

    task.status = "cancelled";
    task.statusMessage =
      "Cancellation requested; waiting for execution to settle.";
    touch(task);
    task.controller.abort(
      new DOMException("MCP task cancelled by client", "AbortError"),
    );
    await task.settlement;
    task.statusMessage = cancellationStatusMessage(task.response);
    touch(task);
    return { jsonrpc: "2.0", id, result: taskView(task) };
  }

  list(
    id: JsonRpcResponse["id"],
    sessionId: string,
    cursor: unknown,
  ): JsonRpcResponse {
    this.prune();
    if (cursor !== undefined && typeof cursor !== "string") {
      return invalidTask(id, "Task cursor must be a string");
    }
    const tasks = [...this.tasks.values()]
      .filter((task) => task.sessionId === sessionId)
      .sort(
        (left, right) =>
          left.createdAtMs - right.createdAtMs ||
          left.taskId.localeCompare(right.taskId),
      );
    let start = 0;
    if (cursor !== undefined) {
      const cursorIndex = tasks.findIndex((task) => task.taskId === cursor);
      if (cursorIndex < 0) return invalidTask(id, "Invalid task cursor");
      start = cursorIndex + 1;
    }
    const page = tasks.slice(start, start + TASK_PAGE_SIZE);
    const next = tasks[start + TASK_PAGE_SIZE];
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tasks: page.map(taskView),
        ...(next ? { nextCursor: page.at(-1)!.taskId } : {}),
      },
    };
  }

  async closeSession(sessionId: string, reason: string): Promise<void> {
    const settlements: Promise<void>[] = [];
    for (const [taskId, task] of this.tasks) {
      if (task.sessionId !== sessionId) continue;
      if (task.settled) {
        this.tasks.delete(taskId);
        continue;
      }
      task.removeOnSettlement = true;
      if (!isTerminal(task.status)) {
        task.status = "cancelled";
        task.statusMessage = reason;
        touch(task);
      }
      task.controller.abort(new DOMException(reason, "AbortError"));
      settlements.push(task.settlement);
    }
    await Promise.all(settlements);
  }

  async closeAll(reason: string): Promise<void> {
    const sessionIds = new Set(
      [...this.tasks.values()].map((task) => task.sessionId),
    );
    await Promise.all(
      [...sessionIds].map((sessionId) => this.closeSession(sessionId, reason)),
    );
  }

  activeCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (!task.settled) count += 1;
    }
    return count;
  }

  private find(sessionId: string, taskId: unknown): McpTaskRecord | Error {
    if (typeof taskId !== "string" || taskId.length === 0) {
      return new Error("Missing required param: taskId");
    }
    const task = this.tasks.get(taskId);
    if (!task || task.sessionId !== sessionId)
      return new Error("Task not found");
    return task;
  }

  private settleResponse(
    task: McpTaskRecord,
    response: JsonRpcResponse | undefined,
  ): void {
    const settledResponse =
      response ??
      jsonRpcError(null, -32_603, "Task completed without a response");
    task.response = settledResponse;
    if (task.status !== "cancelled") {
      task.status = responseFailed(settledResponse) ? "failed" : "completed";
      task.statusMessage =
        task.status === "failed"
          ? "The underlying request failed; retrieve tasks/result for details."
          : "The operation completed successfully.";
      touch(task);
    }
    this.finishSettlement(task);
  }

  private settleError(task: McpTaskRecord, error: unknown): void {
    const ambiguity = findOperationOutcomeAmbiguousError(error);
    task.response = ambiguity
      ? jsonRpcError(null, -32_603, ambiguity.message, {
          outcome_ambiguous: true,
          retryable: false,
          ...(ambiguity.operation ? { operation: ambiguity.operation } : {}),
          ...(ambiguity.target_unusable ? { target_unusable: true } : {}),
        })
      : task.controller.signal.aborted && isCancellation(error)
        ? jsonRpcError(null, REQUEST_CANCELLED, cancellationMessage(error))
        : jsonRpcError(
            null,
            -32_603,
            `Internal error: ${error instanceof Error ? error.message : String(error)}`,
          );
    if (task.status !== "cancelled") {
      task.status =
        task.controller.signal.aborted && isCancellation(error)
          ? "cancelled"
          : "failed";
      task.statusMessage = ambiguity
        ? "The underlying operation settled with an ambiguous external outcome."
        : task.status === "cancelled"
          ? "The task was cancelled before completion."
          : "The underlying request failed; retrieve tasks/result for details.";
      touch(task);
    }
    this.finishSettlement(task);
  }

  private finishSettlement(task: McpTaskRecord): void {
    if (task.settled) return;
    task.settled = true;
    task.resolveSettlement();
    if (task.removeOnSettlement) this.tasks.delete(task.taskId);
    else this.prune();
  }

  private prune(now = Date.now()): void {
    const retained: McpTaskRecord[] = [];
    for (const [taskId, task] of this.tasks) {
      const expiresAt = task.createdAtMs + (task.ttl ?? MAX_TASK_TTL_MS);
      if (expiresAt <= now) {
        if (!task.settled) {
          task.removeOnSettlement = true;
          if (!isTerminal(task.status)) {
            task.status = "cancelled";
            task.statusMessage =
              "Task retention expired; cancelling execution.";
            touch(task);
          }
          task.controller.abort(
            new DOMException("MCP task retention expired", "AbortError"),
          );
        } else {
          this.tasks.delete(taskId);
        }
        continue;
      }
      if (task.settled) retained.push(task);
    }
    retained.sort(
      (left, right) =>
        left.lastUpdatedAtMs - right.lastUpdatedAtMs ||
        left.taskId.localeCompare(right.taskId),
    );
    const excess = retained.length - MAX_RETAINED_TASKS;
    for (let index = 0; index < excess; index++) {
      this.tasks.delete(retained[index]!.taskId);
    }
  }
}

function taskView(task: McpTaskRecord): McpTaskView {
  return {
    taskId: task.taskId,
    status: task.status,
    ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttl: task.ttl,
    ...(task.pollInterval ? { pollInterval: task.pollInterval } : {}),
  };
}

function invalidTask(
  id: JsonRpcResponse["id"],
  message: string,
): JsonRpcResponse {
  return jsonRpcError(id, -32_602, message);
}

function normalizeTtl(requested: number | undefined): number | undefined {
  if (requested === undefined) return DEFAULT_TASK_TTL_MS;
  if (!Number.isSafeInteger(requested) || requested <= 0) return undefined;
  return Math.min(MAX_TASK_TTL_MS, Math.max(MIN_TASK_TTL_MS, requested));
}

function touch(task: McpTaskRecord): void {
  const now = Date.now();
  task.lastUpdatedAtMs = now;
  task.lastUpdatedAt = iso(now);
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function isTerminal(status: McpTaskStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function responseFailed(response: JsonRpcResponse): boolean {
  if (response.error) return true;
  return (
    typeof response.result === "object" &&
    response.result !== null &&
    !Array.isArray(response.result) &&
    (response.result as { isError?: unknown }).isError === true
  );
}

function withRelatedTask(result: unknown, taskId: string): unknown {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return result;
  }
  const record = result as Record<string, unknown>;
  const meta =
    typeof record._meta === "object" &&
    record._meta !== null &&
    !Array.isArray(record._meta)
      ? (record._meta as Record<string, unknown>)
      : {};
  return {
    ...record,
    _meta: {
      ...meta,
      "io.modelcontextprotocol/related-task": { taskId },
    },
  };
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function cancellationMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Task cancelled";
}

function cancellationStatusMessage(
  response: JsonRpcResponse | undefined,
): string {
  if (!response) return "The task was cancelled before completion.";
  if (containsOutcomeAmbiguity(response)) {
    return "Cancellation settled with an ambiguous external outcome; inspect tasks/result before any retry.";
  }
  if (!responseFailed(response)) {
    return "Cancellation was requested after the underlying operation completed; retrieve tasks/result.";
  }
  return "The task was cancelled and execution has settled.";
}

function containsOutcomeAmbiguity(
  value: unknown,
  seen: Set<object> = new Set(),
): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (
    !Array.isArray(value) &&
    (value as Record<string, unknown>).outcome_ambiguous === true
  ) {
    return true;
  }
  return Object.values(value).some((entry) =>
    containsOutcomeAmbiguity(entry, seen),
  );
}

async function waitForSettlement(
  settlement: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (!signal) {
    await settlement;
    return;
  }
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = (): void => rejectAbort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    await Promise.race([settlement, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
