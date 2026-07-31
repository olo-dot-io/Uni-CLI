/**
 * @owner       src::mcp::modern-tasks
 * @does        Implement the MCP 2026 Tasks extension as a durable, stateless, server-directed task state machine.
 * @needs       node:crypto/fs/os/path, shared JSON-RPC contracts, structural outcome-ambiguity errors
 * @feeds       Modern MCP tools/call plus tasks/get, tasks/update, and tasks/cancel
 * @breaks      Returning a handle before durable creation, coupling work to the initiating HTTP stream, or classifying tool-level isError results as protocol failures loses work or violates the extension contract.
 * @invariants  Task ids are high-entropy bearer handles; creation is durably committed before response; status-specific payloads are flat; only JSON-RPC errors fail tasks; cancellation is cooperative and ack-only; task input keys are never reused; authenticated principals remain isolated; retained state is bounded and atomically replaced.
 * @side-effects Persists mode-0600 JSON records under a mode-0700 local task directory and owns active task AbortControllers.
 * @perf        O(1) task lookup by id; each state transition rewrites one bounded record; retention pruning is O(task count) with a hard bound.
 * @concurrency Per-task promise queues serialize local mutations; atomic rename prevents partial records; one active runtime owns each newly created task.
 * @test        tests/unit/mcp/protocol-2026.test.ts
 * @stability   experimental MCP 2026 Tasks extension
 * @since       2026-07-30
 */

import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { findOperationOutcomeAmbiguousError } from "../transport/contained-process.js";
import { withRecoverableFileStoreLockAsync } from "../runtime/recoverable-file-lock.js";
import {
  jsonRpcError,
  type JsonRpcResponse,
  type McpRequestContext,
  type McpTaskInputBridge,
} from "./jsonrpc.js";

export const MCP_TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";
export const MCP_TASKS_CAPABILITY_REQUIRED = -32_021;

export type ModernMcpTaskStatus =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled";

export interface ModernMcpTaskBase {
  taskId: string;
  status: ModernMcpTaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
}

export type ModernMcpDetailedTask =
  | (ModernMcpTaskBase & { status: "working" })
  | (ModernMcpTaskBase & {
      status: "input_required";
      inputRequests: Record<string, Record<string, unknown>>;
    })
  | (ModernMcpTaskBase & {
      status: "completed";
      result: Record<string, unknown>;
    })
  | (ModernMcpTaskBase & {
      status: "failed";
      error: Record<string, unknown>;
    })
  | (ModernMcpTaskBase & { status: "cancelled" });

interface PersistedModernTask extends ModernMcpTaskBase {
  schemaVersion: 1;
  ownerPrincipal?: string;
  workerId?: string;
  inputRequests?: Record<string, Record<string, unknown>>;
  usedInputKeys: string[];
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

interface InputWaiter {
  resolve: (response: Record<string, unknown>) => void;
  reject: (reason: unknown) => void;
}

interface ActiveModernTask {
  ownerKey: string;
  controller: AbortController;
  inputWaiters: Map<string, InputWaiter>;
  usedInputKeys: Set<string>;
  settlement: Promise<void>;
}

export interface ModernMcpTaskManagerOptions {
  directory?: string;
  ttlMs?: number | null;
  pollIntervalMs?: number;
  maxRetainedTasks?: number;
}

export interface CreateModernMcpTaskInput {
  requestId: JsonRpcResponse["id"];
  principalId?: string;
  transport: McpRequestContext["transport"];
  execute: (
    taskId: string,
    context: McpRequestContext,
  ) => JsonRpcResponse | undefined | Promise<JsonRpcResponse | undefined>;
}

export type ModernMcpTaskListener = (task: ModernMcpDetailedTask) => void;

export class ModernTaskStoreCorruptionError extends Error {
  readonly code = "mcp_task_store_corrupt";

  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`Durable MCP task record is corrupt at ${path}: ${reason}`);
    this.name = "ModernTaskStoreCorruptionError";
  }
}

const DEFAULT_TASK_TTL_MS = 86_400_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const MAX_ACTIVE_TASKS = 200;
const MAX_ACTIVE_TASKS_PER_PRINCIPAL = 32;
export const MAX_MCP_TASK_IDS_PER_SUBSCRIPTION = 500;
const MAX_RETAINED_TASKS = MAX_MCP_TASK_IDS_PER_SUBSCRIPTION;
const WORKER_LEASE_INTERVAL_MS = 2_000;
const WORKER_LEASE_STALE_MS = 10_000;
const MAX_TASK_RECORD_BYTES = 1_048_576;
const MAX_TASK_RESULT_BYTES = 768 * 1024;
const MAX_TASK_INPUT_REQUEST_BYTES = 64 * 1024;
const MAX_TASK_INPUT_KEYS = 64;
const MAX_TASK_INPUT_KEY_BYTES = 256;
const TASK_READ_CONCURRENCY = 32;
const TASK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_CANCELLED = -32_800;

function taskOwnerKey(
  principalId: string | undefined,
  transport: McpRequestContext["transport"],
): string {
  return principalId ? `principal:${principalId}` : `anonymous:${transport}`;
}

function incrementCounter(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function decrementCounter(map: Map<string, number>, key: string): void {
  const next = (map.get(key) ?? 0) - 1;
  if (next > 0) map.set(key, next);
  else map.delete(key);
}

export function isModernMcpTaskId(value: string): boolean {
  return TASK_ID_PATTERN.test(value);
}

export class ModernMcpTaskManager {
  private readonly directory: string;
  private readonly ttlMs: number | null;
  private readonly pollIntervalMs: number;
  private readonly maxRetainedTasks: number;
  private readonly workerId = randomUUID();
  private readonly active = new Map<string, ActiveModernTask>();
  private readonly mutationTails = new Map<string, Promise<void>>();
  private readonly listeners = new Set<ModernMcpTaskListener>();
  private readonly corruptTasks = new Map<
    string,
    ModernTaskStoreCorruptionError
  >();
  private readonly ready: Promise<void>;
  private activeTaskReservations = 0;
  private readonly activeByPrincipal = new Map<string, number>();
  private readonly reservationsByPrincipal = new Map<string, number>();
  private readonly inFlightCreates = new Set<Promise<JsonRpcResponse>>();
  private workerLeaseInitialization?: Promise<void>;
  private workerLeaseRefresh?: Promise<void>;
  private workerLeaseTimer?: NodeJS.Timeout;
  private workerLeaseError?: Error;
  private workerLeaseLastSuccess = 0;
  private leaseTerminalFailure = false;
  private workerLeaseContainment?: Promise<void>;
  private pruneSingleflight?: Promise<void>;
  private prunePending = false;
  private pruneTimer?: NodeJS.Timeout;
  private pruneTimerAt?: number;
  private closed = false;

  constructor(options: ModernMcpTaskManagerOptions = {}) {
    this.directory =
      options.directory ??
      process.env.UNICLI_MCP_TASK_STORE_DIR ??
      join(homedir(), ".unicli", "mcp", "tasks-v2026");
    this.ttlMs =
      options.ttlMs === undefined ? DEFAULT_TASK_TTL_MS : options.ttlMs;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const requestedRetention = options.maxRetainedTasks ?? MAX_RETAINED_TASKS;
    this.maxRetainedTasks =
      Number.isFinite(requestedRetention) && requestedRetention >= 0
        ? Math.min(MAX_RETAINED_TASKS, Math.floor(requestedRetention))
        : MAX_RETAINED_TASKS;
    this.ready = this.initialize();
  }

  async create(input: CreateModernMcpTaskInput): Promise<JsonRpcResponse> {
    await this.ready;
    if (this.closed) {
      return jsonRpcError(input.requestId, -32_603, "Task manager is closed");
    }
    if (this.active.size + this.activeTaskReservations >= MAX_ACTIVE_TASKS) {
      return jsonRpcError(
        input.requestId,
        -32_603,
        "Server at capacity: too many active tasks",
      );
    }
    const ownerKey = taskOwnerKey(input.principalId, input.transport);
    if (
      (this.activeByPrincipal.get(ownerKey) ?? 0) +
        (this.reservationsByPrincipal.get(ownerKey) ?? 0) >=
      MAX_ACTIVE_TASKS_PER_PRINCIPAL
    ) {
      return jsonRpcError(
        input.requestId,
        -32_603,
        "Principal at capacity: too many active tasks",
      );
    }
    this.activeTaskReservations += 1;
    incrementCounter(this.reservationsByPrincipal, ownerKey);
    const creation = this.createReserved(input, ownerKey);
    this.inFlightCreates.add(creation);
    try {
      return await creation;
    } finally {
      this.inFlightCreates.delete(creation);
      this.activeTaskReservations -= 1;
      decrementCounter(this.reservationsByPrincipal, ownerKey);
    }
  }

  private async createReserved(
    input: CreateModernMcpTaskInput,
    ownerKey: string,
  ): Promise<JsonRpcResponse> {
    const taskId = randomUUID();
    const now = Date.now();
    const task: PersistedModernTask = {
      schemaVersion: 1,
      taskId,
      status: "working",
      statusMessage: "The operation is now in progress.",
      createdAt: iso(now),
      lastUpdatedAt: iso(now),
      ttlMs: this.ttlMs,
      pollIntervalMs: this.pollIntervalMs,
      ...(input.principalId ? { ownerPrincipal: input.principalId } : {}),
      workerId: this.workerId,
      usedInputKeys: [],
    };
    const runtime: ActiveModernTask = {
      ownerKey,
      controller: new AbortController(),
      inputWaiters: new Map(),
      usedInputKeys: new Set(),
      settlement: Promise.resolve(),
    };

    await this.ensureWorkerLease();
    // Strongly consistent creation: this write completes before the handle is
    // observable in the tools/call response.
    await this.writeTask(task);
    this.active.set(taskId, runtime);
    incrementCounter(this.activeByPrincipal, ownerKey);
    this.publish(task);
    runtime.settlement = Promise.resolve()
      .then(() => {
        runtime.controller.signal.throwIfAborted();
        return input.execute(taskId, {
          transport: input.transport,
          principalId: input.principalId,
          signal: runtime.controller.signal,
          task: this.createInputBridge(taskId),
        });
      })
      .then(
        (response) => this.settleResponse(taskId, response),
        (error: unknown) => this.settleThrown(taskId, error),
      )
      .catch((error: unknown) => {
        this.finishRuntime(taskId);
        process.stderr.write(
          `[unicli-mcp] modern task ${taskId} settlement failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });

    return {
      jsonrpc: "2.0",
      id: input.requestId,
      result: {
        resultType: "task",
        ...taskBaseView(task),
      },
    };
  }

  async get(
    id: JsonRpcResponse["id"],
    principalId: string | undefined,
    taskId: unknown,
  ): Promise<JsonRpcResponse> {
    await this.ready;
    const task = await this.findTask(taskId, principalId);
    if (task instanceof Error) return invalidTask(id, task.message);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        resultType: "complete",
        ...detailedTaskView(task),
      },
    };
  }

  async update(
    id: JsonRpcResponse["id"],
    principalId: string | undefined,
    taskId: unknown,
    inputResponses: unknown,
  ): Promise<JsonRpcResponse> {
    await this.ready;
    if (!isRecord(inputResponses)) {
      return invalidTask(id, "inputResponses must be an object");
    }
    const task = await this.findTask(taskId, principalId);
    if (task instanceof Error) return invalidTask(id, task.message);
    if (!isTerminal(task.status) && task.workerId !== this.workerId) {
      return workerMisroute(id, task.taskId);
    }
    await this.mutate(task.taskId, async () => {
      const current = await this.readTask(task.taskId);
      if (!current || !ownsTask(current, principalId)) return;
      const outstanding = { ...current.inputRequests };
      const runtime = this.active.get(current.taskId);
      const accepted: Array<[string, Record<string, unknown>]> = [];
      for (const [key, value] of Object.entries(inputResponses)) {
        if (!Object.hasOwn(outstanding, key) || !isRecord(value)) continue;
        delete outstanding[key];
        accepted.push([key, value]);
      }
      if (accepted.length === 0) return;
      current.inputRequests = outstanding;
      if (
        current.status === "input_required" &&
        Object.keys(outstanding).length === 0
      ) {
        current.status = "working";
        current.statusMessage = "Client input received; work resumed.";
      }
      touch(current);
      await this.writeTask(current);
      this.publish(current);
      for (const [key, value] of accepted) {
        runtime?.inputWaiters.get(key)?.resolve(value);
        runtime?.inputWaiters.delete(key);
      }
    });
    return { jsonrpc: "2.0", id, result: { resultType: "complete" } };
  }

  async cancel(
    id: JsonRpcResponse["id"],
    principalId: string | undefined,
    taskId: unknown,
  ): Promise<JsonRpcResponse> {
    await this.ready;
    const task = await this.findTask(taskId, principalId);
    if (task instanceof Error) return invalidTask(id, task.message);
    if (!isTerminal(task.status) && task.workerId !== this.workerId) {
      return workerMisroute(id, task.taskId);
    }
    if (!isTerminal(task.status)) {
      const runtime = this.active.get(task.taskId);
      runtime?.controller.abort(
        new DOMException("MCP task cancellation requested", "AbortError"),
      );
      for (const waiter of runtime?.inputWaiters.values() ?? []) {
        waiter.reject(
          new DOMException("MCP task cancellation requested", "AbortError"),
        );
      }
      runtime?.inputWaiters.clear();
    }
    // Cancellation is cooperative and eventually consistent. The
    // acknowledgement deliberately does not claim a new observable status.
    return { jsonrpc: "2.0", id, result: { resultType: "complete" } };
  }

  async closeAll(reason: string): Promise<void> {
    this.closed = true;
    this.clearPruneTimer();
    await this.ready;
    await Promise.allSettled(this.inFlightCreates);
    const settlements: Promise<void>[] = [];
    for (const runtime of this.active.values()) {
      runtime.controller.abort(new DOMException(reason, "AbortError"));
      for (const waiter of runtime.inputWaiters.values()) {
        waiter.reject(new DOMException(reason, "AbortError"));
      }
      runtime.inputWaiters.clear();
      settlements.push(runtime.settlement);
    }
    await Promise.allSettled(settlements);
    await this.pruneSingleflight?.catch(() => undefined);
    this.clearPruneTimer();
    await this.workerLeaseInitialization?.catch(() => undefined);
    if (this.workerLeaseTimer) clearInterval(this.workerLeaseTimer);
    this.workerLeaseTimer = undefined;
    await this.workerLeaseRefresh?.catch(() => undefined);
    await this.workerLeaseContainment?.catch(() => undefined);
    await this.deleteWorkerLease();
  }

  private createInputBridge(taskId: string): McpTaskInputBridge {
    return {
      taskId,
      requestInput: (key, request) => this.requestInput(taskId, key, request),
    };
  }

  private async requestInput(
    taskId: string,
    key: string,
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!key) throw new Error("Task input key must not be empty");
    if (Buffer.byteLength(key, "utf8") > MAX_TASK_INPUT_KEY_BYTES) {
      throw new Error(
        `Task input key exceeds ${String(MAX_TASK_INPUT_KEY_BYTES)} bytes`,
      );
    }
    if (jsonByteLength(request) > MAX_TASK_INPUT_REQUEST_BYTES) {
      throw new Error(
        `Task input request exceeds ${String(MAX_TASK_INPUT_REQUEST_BYTES)} bytes`,
      );
    }
    const runtime = this.active.get(taskId);
    if (!runtime) throw new Error("Task execution is no longer active");
    if (runtime.controller.signal.aborted) {
      throw runtime.controller.signal.reason;
    }
    if (runtime.inputWaiters.has(key)) {
      throw new Error(`Task input key is already pending: ${key}`);
    }
    if (runtime.usedInputKeys.has(key)) {
      throw new Error(`Task input key has already been used: ${key}`);
    }
    if (runtime.usedInputKeys.size >= MAX_TASK_INPUT_KEYS) {
      throw new Error(
        `Task input key count exceeds ${String(MAX_TASK_INPUT_KEYS)}`,
      );
    }
    let resolveResponse!: (response: Record<string, unknown>) => void;
    let rejectResponse!: (reason: unknown) => void;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    runtime.inputWaiters.set(key, {
      resolve: resolveResponse,
      reject: rejectResponse,
    });
    try {
      await this.mutate(taskId, async () => {
        const task = await this.readTask(taskId);
        if (!task || isTerminal(task.status)) {
          throw new Error("Task execution is no longer active");
        }
        if (
          runtime.usedInputKeys.has(key) ||
          task.usedInputKeys.includes(key)
        ) {
          throw new Error(`Task input key has already been used: ${key}`);
        }
        task.usedInputKeys.push(key);
        runtime.usedInputKeys.add(key);
        task.inputRequests = { ...task.inputRequests, [key]: request };
        task.status = "input_required";
        task.statusMessage =
          "Client input is required before work can continue.";
        touch(task);
        await this.writeTask(task);
        this.publish(task);
      });
    } catch (error) {
      runtime.inputWaiters.delete(key);
      throw error;
    }
    return response;
  }

  private async settleResponse(
    taskId: string,
    response: JsonRpcResponse | undefined,
  ): Promise<void> {
    await this.mutate(taskId, async () => {
      const task = await this.readTask(taskId);
      if (!task || isTerminal(task.status)) return;
      if (!response) {
        task.status = "failed";
        task.statusMessage = "Task completed without a JSON-RPC response.";
        task.error = {
          code: -32_603,
          message: "Task completed without a response",
        };
      } else if (response.error) {
        task.status = "failed";
        if (jsonByteLength(response.error) > MAX_TASK_RESULT_BYTES) {
          task.statusMessage =
            "The operation error exceeded the durable task limit.";
          task.error = {
            code: -32_603,
            message: "Task error is too large",
            data: {
              reason: "task_error_too_large",
              maximumBytes: MAX_TASK_RESULT_BYTES,
              retryable: false,
            },
          };
        } else {
          task.statusMessage = boundedText(response.error.message, 2_000);
          task.error = response.error;
        }
      } else {
        const result = resultRecord(response.result);
        if (jsonByteLength(result) > MAX_TASK_RESULT_BYTES) {
          task.status = "failed";
          task.statusMessage =
            "The operation result exceeded the durable task limit.";
          task.error = {
            code: -32_603,
            message: "Task result is too large",
            data: {
              reason: "task_result_too_large",
              maximumBytes: MAX_TASK_RESULT_BYTES,
              retryable: false,
            },
          };
        } else {
          task.status = "completed";
          task.statusMessage = "The operation completed.";
          task.result = result;
        }
      }
      delete task.inputRequests;
      delete task.workerId;
      touch(task);
      await this.writeTask(task);
      this.publish(task);
    });
    this.finishRuntime(taskId);
    await this.prune();
  }

  private async settleThrown(taskId: string, error: unknown): Promise<void> {
    await this.mutate(taskId, async () => {
      const task = await this.readTask(taskId);
      if (!task || isTerminal(task.status)) return;
      const runtime = this.active.get(taskId);
      const ambiguity = findOperationOutcomeAmbiguousError(error);
      if (runtime?.controller.signal.aborted && isCancellation(error)) {
        task.status = "cancelled";
        task.statusMessage = cancellationMessage(error);
      } else {
        task.status = "failed";
        task.statusMessage = ambiguity
          ? "The operation settled with an ambiguous external outcome."
          : error instanceof Error
            ? boundedText(error.message, 2_000)
            : boundedText(String(error), 2_000);
        task.error = ambiguity
          ? {
              code: -32_603,
              message: boundedText(ambiguity.message, 2_000),
              data: {
                outcome_ambiguous: true,
                retryable: false,
                ...(ambiguity.operation
                  ? { operation: ambiguity.operation }
                  : {}),
                ...(ambiguity.target_unusable ? { target_unusable: true } : {}),
              },
            }
          : {
              code:
                runtime?.controller.signal.aborted && isCancellation(error)
                  ? REQUEST_CANCELLED
                  : -32_603,
              message: `Internal error: ${boundedText(
                error instanceof Error ? error.message : String(error),
                2_000,
              )}`,
            };
      }
      delete task.inputRequests;
      delete task.workerId;
      touch(task);
      await this.writeTask(task);
      this.publish(task);
    });
    this.finishRuntime(taskId);
    await this.prune();
  }

  private finishRuntime(taskId: string): void {
    const runtime = this.active.get(taskId);
    for (const waiter of runtime?.inputWaiters.values() ?? []) {
      waiter.reject(new Error("Task settled before input was accepted"));
    }
    if (runtime && this.active.delete(taskId)) {
      decrementCounter(this.activeByPrincipal, runtime.ownerKey);
    }
  }

  subscribe(listener: ModernMcpTaskListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async selectObservableTaskIds(
    taskIds: readonly string[],
    principalId: string | undefined,
  ): Promise<string[]> {
    return (await this.readObservableTasks(taskIds, principalId)).map(
      (task) => task.taskId,
    );
  }

  async readObservableTasks(
    taskIds: readonly string[],
    principalId: string | undefined,
  ): Promise<ModernMcpDetailedTask[]> {
    await this.ready;
    const uniqueTaskIds = [...new Set(taskIds)];
    const observable: Array<ModernMcpDetailedTask | undefined> = [];
    for (
      let offset = 0;
      offset < uniqueTaskIds.length;
      offset += TASK_READ_CONCURRENCY
    ) {
      observable.push(
        ...(await Promise.all(
          uniqueTaskIds
            .slice(offset, offset + TASK_READ_CONCURRENCY)
            .map(async (taskId) => {
              if (!isModernMcpTaskId(taskId)) return undefined;
              const task = await this.readTask(taskId);
              return task && ownsTask(task, principalId) && !isExpired(task)
                ? detailedTaskView(task)
                : undefined;
            }),
        )),
      );
    }
    return observable.filter(
      (task): task is ModernMcpDetailedTask => task !== undefined,
    );
  }

  private async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await mkdir(this.workerDirectory(), { recursive: true, mode: 0o700 });
    await mkdir(this.taskLockDirectory(), { recursive: true, mode: 0o700 });
    await this.recoverOrphanedTasks();
    await this.prune();
  }

  private async recoverOrphanedTasks(): Promise<void> {
    const names = await this.taskFileNames();
    for (const name of names) {
      const task = await this.readTaskFile(name, true);
      if (!task || isTerminal(task.status) || task.workerId === undefined) {
        continue;
      }
      if (await this.workerLeaseIsLive(task.workerId)) continue;
      await this.mutate(task.taskId, async () => {
        const current = await this.readTaskFile(name, true);
        if (
          !current ||
          isTerminal(current.status) ||
          current.workerId === undefined ||
          (await this.workerLeaseIsLive(current.workerId))
        ) {
          return;
        }
        current.status = "failed";
        current.statusMessage =
          "The worker stopped before the operation reached a terminal result.";
        current.error = {
          code: -32_603,
          message: "Task worker is no longer available",
        };
        delete current.inputRequests;
        delete current.workerId;
        touch(current);
        await this.writeTask(current);
      });
    }
  }

  private async findTask(
    taskId: unknown,
    principalId: string | undefined,
  ): Promise<PersistedModernTask | Error> {
    if (typeof taskId !== "string" || !TASK_ID_PATTERN.test(taskId)) {
      return new Error("Missing or invalid taskId");
    }
    const task = await this.readTask(taskId);
    if (!task || !ownsTask(task, principalId))
      return new Error("Task not found");
    if (isExpired(task)) {
      if (isTerminal(task.status) && !this.active.has(taskId)) {
        await this.deleteTask(taskId);
      }
      return new Error("Task has expired");
    }
    return task;
  }

  private async mutate(
    taskId: string,
    mutation: () => Promise<void>,
  ): Promise<void> {
    const prior = this.mutationTails.get(taskId) ?? Promise.resolve();
    const run = async (): Promise<void> => {
      const lockRoot = join(this.taskLockDirectory(), taskId);
      await mkdir(lockRoot, { recursive: true, mode: 0o700 });
      await withRecoverableFileStoreLockAsync(lockRoot, mutation);
    };
    const current = prior.then(run, run);
    this.mutationTails.set(taskId, current);
    try {
      await current;
    } finally {
      if (this.mutationTails.get(taskId) === current) {
        this.mutationTails.delete(taskId);
      }
    }
  }

  private async prune(): Promise<void> {
    this.prunePending = true;
    if (this.pruneSingleflight) return this.pruneSingleflight;
    const operation = (async () => {
      // Let settlements from the same turn join this scan.
      await Promise.resolve();
      do {
        this.prunePending = false;
        await this.performPrune();
      } while (this.prunePending);
    })();
    this.pruneSingleflight = operation.finally(() => {
      this.pruneSingleflight = undefined;
    });
    return this.pruneSingleflight;
  }

  private async performPrune(): Promise<void> {
    const records: Array<
      Pick<
        PersistedModernTask,
        "taskId" | "status" | "lastUpdatedAt" | "createdAt" | "ttlMs"
      >
    > = [];
    const fileNames = await this.taskFileNames();
    for (
      let offset = 0;
      offset < fileNames.length;
      offset += TASK_READ_CONCURRENCY
    ) {
      const batch = await Promise.all(
        fileNames
          .slice(offset, offset + TASK_READ_CONCURRENCY)
          .map((name) => this.readTaskFile(name, true)),
      );
      for (const task of batch) {
        if (!task) continue;
        // Retention needs only fixed-size metadata. Do not retain up to 1 MiB
        // of result/input payload per task after each bounded read batch.
        records.push({
          taskId: task.taskId,
          status: task.status,
          lastUpdatedAt: task.lastUpdatedAt,
          createdAt: task.createdAt,
          ttlMs: task.ttlMs,
        });
      }
    }
    const retained = records
      .filter(
        (task) => isTerminal(task.status) && !this.active.has(task.taskId),
      )
      .sort(
        (left, right) =>
          Date.parse(left.lastUpdatedAt) - Date.parse(right.lastUpdatedAt) ||
          left.taskId.localeCompare(right.taskId),
      );
    const expired = retained.filter((task) => isExpired(task));
    const overLimit = retained.slice(
      0,
      Math.max(0, retained.length - this.maxRetainedTasks),
    );
    const removed = new Map(
      [...expired, ...overLimit].map((entry) => [entry.taskId, entry]),
    );
    for (const task of removed.values()) {
      await this.deleteTask(task.taskId);
    }
    await this.pruneWorkerLeases();
    const nextExpiry = retained.reduce<number | undefined>((soonest, task) => {
      if (removed.has(task.taskId) || task.ttlMs === null) return soonest;
      const expiry = Date.parse(task.createdAt) + task.ttlMs;
      if (expiry <= Date.now()) return soonest;
      return soonest === undefined || expiry < soonest ? expiry : soonest;
    }, undefined);
    this.schedulePrune(nextExpiry);
  }

  private schedulePrune(at: number | undefined): void {
    if (this.closed || at === undefined) {
      this.clearPruneTimer();
      return;
    }
    if (this.pruneTimer && this.pruneTimerAt === at) return;
    this.clearPruneTimer();
    this.pruneTimerAt = at;
    const delay = Math.min(Math.max(1, at - Date.now()), 2_147_483_647);
    this.pruneTimer = setTimeout(() => {
      this.pruneTimer = undefined;
      this.pruneTimerAt = undefined;
      if (this.closed) return;
      void this.prune().catch((error: unknown) => {
        process.stderr.write(
          `[unicli-mcp] modern task expiry prune failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
    }, delay);
    this.pruneTimer.unref();
  }

  private clearPruneTimer(): void {
    if (this.pruneTimer) clearTimeout(this.pruneTimer);
    this.pruneTimer = undefined;
    this.pruneTimerAt = undefined;
  }

  private async taskFileNames(): Promise<string[]> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".json") &&
          TASK_ID_PATTERN.test(entry.name.slice(0, -5)),
      )
      .map((entry) => entry.name);
  }

  private taskPath(taskId: string): string {
    return join(this.directory, `${taskId}.json`);
  }

  private async readTask(
    taskId: string,
  ): Promise<PersistedModernTask | undefined> {
    const corruption = this.corruptTasks.get(taskId);
    if (corruption) throw corruption;
    return this.readTaskFile(`${taskId}.json`);
  }

  private async readTaskFile(
    name: string,
    quarantineCorrupt = false,
  ): Promise<PersistedModernTask | undefined> {
    try {
      const path = join(this.directory, name);
      const info = await stat(path);
      if (info.size > MAX_TASK_RECORD_BYTES) {
        throw new ModernTaskStoreCorruptionError(
          path,
          `record exceeds ${String(MAX_TASK_RECORD_BYTES)} bytes`,
        );
      }
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      const reason = invalidPersistedTaskReason(
        parsed,
        name.endsWith(".json") ? name.slice(0, -5) : undefined,
      );
      if (!reason) return parsed as PersistedModernTask;
      throw new ModernTaskStoreCorruptionError(
        join(this.directory, name),
        reason,
      );
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      const corruption =
        error instanceof ModernTaskStoreCorruptionError
          ? error
          : new ModernTaskStoreCorruptionError(
              join(this.directory, name),
              error instanceof Error ? error.message : String(error),
            );
      if (!quarantineCorrupt) throw corruption;
      await this.quarantineCorruptTask(name, corruption);
      return undefined;
    }
  }

  private async quarantineCorruptTask(
    name: string,
    corruption: ModernTaskStoreCorruptionError,
  ): Promise<void> {
    const taskId = name.endsWith(".json") ? name.slice(0, -5) : name;
    this.corruptTasks.set(taskId, corruption);
    const source = join(this.directory, name);
    const destination = join(
      this.directory,
      `${name}.corrupt.${Date.now()}.${randomUUID()}`,
    );
    try {
      await rename(source, destination);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    process.stderr.write(`[unicli-mcp] ${corruption.message}; quarantined\n`);
  }

  private async writeTask(task: PersistedModernTask): Promise<void> {
    if (
      task.workerId === this.workerId &&
      this.workerLeaseError &&
      !this.leaseTerminalFailure
    ) {
      throw this.workerLeaseError;
    }
    const serialized = `${JSON.stringify(task)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_TASK_RECORD_BYTES) {
      throw new Error(
        `Durable MCP task record exceeds ${String(MAX_TASK_RECORD_BYTES)} bytes`,
      );
    }
    await this.writeAtomicJson(this.taskPath(task.taskId), task, serialized);
  }

  private async writeAtomicJson(
    destination: string,
    value: unknown,
    serialized = `${JSON.stringify(value)}\n`,
  ): Promise<void> {
    const parent = dirname(destination);
    const temporary = join(parent, `.${process.pid}.${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      try {
        await file.writeFile(serialized, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, destination);
      await syncDirectory(parent);
    } catch (error) {
      try {
        await unlink(temporary);
      } catch (cleanupError) {
        if (!isNodeError(cleanupError, "ENOENT")) {
          throw new AggregateError(
            [error, cleanupError],
            "atomic task write and temporary-file cleanup both failed",
          );
        }
      }
      throw error;
    }
  }

  private async deleteTask(taskId: string): Promise<void> {
    await this.mutate(taskId, async () => {
      try {
        await unlink(this.taskPath(taskId));
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
    });
    await this.removeUnusedTaskLock(
      taskId,
      join(this.taskLockDirectory(), taskId),
    );
  }

  private workerDirectory(): string {
    return join(this.directory, "workers");
  }

  private taskLockDirectory(): string {
    return join(this.directory, "locks");
  }

  private async removeUnusedTaskLock(
    taskId: string,
    lockRoot: string,
  ): Promise<void> {
    try {
      await stat(this.taskPath(taskId));
      return;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    try {
      await rmdir(lockRoot);
    } catch (error) {
      if (!isNodeError(error, "ENOENT") && !isNodeError(error, "ENOTEMPTY")) {
        throw error;
      }
    }
  }

  private workerLeasePath(workerId: string = this.workerId): string {
    return join(this.workerDirectory(), `${workerId}.json`);
  }

  private async ensureWorkerLease(): Promise<void> {
    if (this.closed) throw new Error("Task manager is closed");
    if (this.workerLeaseError) throw this.workerLeaseError;
    if (this.workerLeaseTimer) return;
    if (!this.workerLeaseInitialization) {
      const initialization = (async () => {
        await this.refreshWorkerLease();
        if (this.closed) return;
        this.workerLeaseTimer = setInterval(() => {
          if (this.closed || this.workerLeaseRefresh) return;
          const refresh = this.refreshWorkerLease()
            .catch((error: unknown) => {
              this.workerLeaseError =
                error instanceof Error ? error : new Error(String(error));
              process.stderr.write(
                `[unicli-mcp] modern task worker lease failed: ${this.workerLeaseError.message}\n`,
              );
              if (
                Date.now() - this.workerLeaseLastSuccess >
                WORKER_LEASE_STALE_MS
              ) {
                this.workerLeaseContainment ??=
                  this.containWorkerLeaseFailure();
              }
            })
            .finally(() => {
              if (this.workerLeaseRefresh === refresh) {
                this.workerLeaseRefresh = undefined;
              }
            });
          this.workerLeaseRefresh = refresh;
        }, WORKER_LEASE_INTERVAL_MS);
        this.workerLeaseTimer.unref();
      })();
      this.workerLeaseInitialization = initialization;
    }
    try {
      await this.workerLeaseInitialization;
    } catch (error) {
      this.workerLeaseError =
        error instanceof Error ? error : new Error(String(error));
      throw this.workerLeaseError;
    }
  }

  private async refreshWorkerLease(): Promise<void> {
    await this.writeAtomicJson(this.workerLeasePath(), {
      workerId: this.workerId,
      pid: process.pid,
      refreshedAt: iso(Date.now()),
    });
    this.workerLeaseLastSuccess = Date.now();
    this.workerLeaseError = undefined;
  }

  private async containWorkerLeaseFailure(): Promise<void> {
    this.closed = true;
    this.leaseTerminalFailure = true;
    if (this.workerLeaseTimer) clearInterval(this.workerLeaseTimer);
    this.workerLeaseTimer = undefined;
    const reason = new Error(
      "Task worker lease could not be durably refreshed before its stale deadline",
    );
    for (const runtime of this.active.values()) {
      runtime.controller.abort(reason);
      for (const waiter of runtime.inputWaiters.values()) {
        waiter.reject(reason);
      }
      runtime.inputWaiters.clear();
    }
    await this.deleteWorkerLease();
  }

  private async workerLeaseIsLive(workerId: string): Promise<boolean> {
    try {
      const path = this.workerLeasePath(workerId);
      const info = await stat(path);
      if (Date.now() - info.mtimeMs <= WORKER_LEASE_STALE_MS) return true;
      const lease = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (
        typeof lease !== "object" ||
        lease === null ||
        Array.isArray(lease) ||
        (lease as { workerId?: unknown }).workerId !== workerId
      ) {
        return false;
      }
      const pid = (lease as { pid?: unknown }).pid;
      return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0
        ? processIsLive(pid)
        : false;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      if (error instanceof SyntaxError) return false;
      throw error;
    }
  }

  private async deleteWorkerLease(): Promise<void> {
    try {
      await unlink(this.workerLeasePath());
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }

  private publish(task: PersistedModernTask): void {
    if (this.listeners.size === 0) return;
    const view = detailedTaskView(task);
    for (const listener of this.listeners) listener(view);
  }

  private async pruneWorkerLeases(): Promise<void> {
    const entries = await readdir(this.workerDirectory(), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const workerId = entry.name.slice(0, -5);
      if (workerId === this.workerId) continue;
      if (!(await this.workerLeaseIsLive(workerId))) {
        try {
          await unlink(this.workerLeasePath(workerId));
        } catch (error) {
          if (!isNodeError(error, "ENOENT")) throw error;
        }
      }
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function taskBaseView(task: PersistedModernTask): ModernMcpTaskBase {
  return {
    taskId: task.taskId,
    status: task.status,
    ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttlMs: task.ttlMs,
    ...(task.pollIntervalMs ? { pollIntervalMs: task.pollIntervalMs } : {}),
  };
}

function detailedTaskView(task: PersistedModernTask): ModernMcpDetailedTask {
  const base = taskBaseView(task);
  switch (task.status) {
    case "working":
      return { ...base, status: "working" };
    case "input_required":
      return {
        ...base,
        status: "input_required",
        inputRequests: task.inputRequests ?? {},
      };
    case "completed":
      return { ...base, status: "completed", result: task.result! };
    case "failed":
      return { ...base, status: "failed", error: task.error! };
    case "cancelled":
      return { ...base, status: "cancelled" };
  }
}

function invalidTask(
  id: JsonRpcResponse["id"],
  message: string,
): JsonRpcResponse {
  return jsonRpcError(id, -32_602, message);
}

function workerMisroute(
  id: JsonRpcResponse["id"],
  taskId: string,
): JsonRpcResponse {
  return jsonRpcError(
    id,
    -32_603,
    "Task update reached a worker that does not own the live execution",
    {
      reason: "worker_misroute",
      taskId,
      retryable: true,
    },
  );
}

function ownsTask(
  task: PersistedModernTask,
  principalId: string | undefined,
): boolean {
  return (
    task.ownerPrincipal === undefined || task.ownerPrincipal === principalId
  );
}

function resultRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { value };
}

function invalidPersistedTaskReason(
  value: unknown,
  expectedTaskId?: string,
): string | undefined {
  if (!isRecord(value)) return "record must be an object";
  if (value.schemaVersion !== 1) return "schemaVersion must be 1";
  if (typeof value.taskId !== "string" || !TASK_ID_PATTERN.test(value.taskId)) {
    return "taskId must be a UUIDv4";
  }
  if (expectedTaskId && value.taskId !== expectedTaskId) {
    return "taskId does not match its file name";
  }
  if (!isTaskStatus(value.status)) return "status is invalid";
  if (!isIsoTimestamp(value.createdAt)) return "createdAt must be ISO-8601";
  if (!isIsoTimestamp(value.lastUpdatedAt)) {
    return "lastUpdatedAt must be ISO-8601";
  }
  if (
    value.ttlMs !== null &&
    (typeof value.ttlMs !== "number" ||
      !Number.isSafeInteger(value.ttlMs) ||
      value.ttlMs <= 0)
  ) {
    return "ttlMs must be null or a positive safe integer";
  }
  if (
    value.pollIntervalMs !== undefined &&
    (typeof value.pollIntervalMs !== "number" ||
      !Number.isSafeInteger(value.pollIntervalMs) ||
      value.pollIntervalMs <= 0)
  ) {
    return "pollIntervalMs must be a positive safe integer";
  }
  if (
    value.statusMessage !== undefined &&
    typeof value.statusMessage !== "string"
  ) {
    return "statusMessage must be a string";
  }
  if (
    value.ownerPrincipal !== undefined &&
    (typeof value.ownerPrincipal !== "string" || !value.ownerPrincipal)
  ) {
    return "ownerPrincipal must be a non-empty string";
  }
  if (
    !Array.isArray(value.usedInputKeys) ||
    value.usedInputKeys.some(
      (entry) => typeof entry !== "string" || entry.length === 0,
    ) ||
    new Set(value.usedInputKeys).size !== value.usedInputKeys.length
  ) {
    return "usedInputKeys must contain unique non-empty strings";
  }
  if (
    value.inputRequests !== undefined &&
    (!isRecord(value.inputRequests) ||
      Object.values(value.inputRequests).some((entry) => !isRecord(entry)))
  ) {
    return "inputRequests must map keys to request objects";
  }

  const hasInput =
    isRecord(value.inputRequests) &&
    Object.keys(value.inputRequests).length > 0;
  const hasInputField = value.inputRequests !== undefined;
  const hasResult = isRecord(value.result);
  const hasError = isRecord(value.error);
  const hasWorker =
    typeof value.workerId === "string" && TASK_ID_PATTERN.test(value.workerId);
  switch (value.status) {
    case "working":
      return hasWorker && !hasInput && !hasResult && !hasError
        ? undefined
        : "working requires one worker and no terminal/input payload";
    case "input_required":
      return hasWorker && hasInput && !hasResult && !hasError
        ? undefined
        : "input_required requires one worker and non-empty inputRequests";
    case "completed":
      return !hasWorker && !hasInputField && hasResult && !hasError
        ? undefined
        : "completed requires result and no worker/input/error payload";
    case "failed":
      return !hasWorker && !hasInputField && !hasResult && hasError
        ? undefined
        : "failed requires error and no worker/input/result payload";
    case "cancelled":
      return !hasWorker && !hasInputField && !hasResult && !hasError
        ? undefined
        : "cancelled must not retain worker, input, result, or error payload";
  }
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isTaskStatus(value: unknown): value is ModernMcpTaskStatus {
  return (
    value === "working" ||
    value === "input_required" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function isExpired(
  task: Pick<PersistedModernTask, "createdAt" | "ttlMs">,
  now = Date.now(),
): boolean {
  return task.ttlMs !== null && Date.parse(task.createdAt) + task.ttlMs <= now;
}

function isTerminal(status: ModernMcpTaskStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function touch(task: PersistedModernTask): void {
  task.lastUpdatedAt = iso(Date.now());
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function jsonByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function boundedText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function cancellationMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Task cancelled";
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error, "ESRCH")) return false;
    if (isNodeError(error, "EPERM")) return true;
    throw error;
  }
}
