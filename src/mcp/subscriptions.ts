/**
 * @owner       src::mcp::subscriptions
 * @does        Own modern MCP subscriptions/listen filtering, first-message acknowledgment, task-status fanout, and graceful closure.
 * @needs       modern durable task manager and shared JSON-RPC server-message contracts
 * @feeds       MCP stdio and Streamable HTTP long-lived notification streams
 * @breaks      Sending an unrequested event, emitting before acknowledgment, or losing subscription identity makes stateless notifications ambiguous.
 * @invariants  Every stream is opt-in; acknowledgment is the first message for its subscription id; task ids are authorized before acceptance; status notifications carry complete task state; delivery is serialized per stream; client cancellation emits no final response; server closure emits one correlated complete result.
 * @side-effects Holds bounded in-memory listeners only for the lifetime of open transport streams.
 * @perf        O(1) task-id index lookup and O(matching subscriptions) fanout; active streams are hard bounded.
 * @concurrency A per-subscription promise tail preserves message order and one terminal transition.
 * @test        tests/unit/mcp/protocol-2026.test.ts, tests/unit/streamable-http.test.ts, tests/unit/mcp/stdio-transport.test.ts
 * @stability   experimental MCP 2026-07-28
 * @since       2026-07-30
 */

import { randomUUID } from "node:crypto";

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcServerMessage,
  McpRequestContext,
} from "./jsonrpc.js";
import {
  isModernMcpTaskId,
  MAX_MCP_TASK_IDS_PER_SUBSCRIPTION,
  MCP_TASKS_CAPABILITY_REQUIRED,
  type ModernMcpDetailedTask,
  ModernMcpTaskManager,
} from "./modern-tasks.js";

interface SubscriptionFilter {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  resourceSubscriptions?: string[];
  taskIds?: string[];
}

interface ActiveSubscription {
  internalId: string;
  requestId: string | number;
  taskIds: Set<string>;
  acknowledged: boolean;
  queuedTasks: Map<string, ModernMcpDetailedTask>;
  taskPump?: Promise<void>;
  emitTail: Promise<void>;
  emit: (message: JsonRpcServerMessage) => void | Promise<void>;
  resolveClosure: (serverInitiated: boolean) => void;
  closure: Promise<boolean>;
  closed: boolean;
}

export interface ListenSubscriptionInput {
  request: JsonRpcRequest;
  principalId?: string;
  signal?: AbortSignal;
  emit?: McpRequestContext["emit"];
  tasksExtensionEnabled: boolean;
}

const MAX_ACTIVE_SUBSCRIPTIONS = 200;

export class McpSubscriptionManager {
  private readonly active = new Map<string, ActiveSubscription>();
  private readonly subscriptionsByTask = new Map<string, Set<string>>();
  private readonly unsubscribeTasks: () => void;
  private pendingSubscriptions = 0;
  private readonly pendingRegistrations = new Set<Promise<void>>();
  private closing = false;

  constructor(private readonly tasks: ModernMcpTaskManager) {
    this.unsubscribeTasks = tasks.subscribe((task) => this.publishTask(task));
  }

  async listen(input: ListenSubscriptionInput): Promise<JsonRpcResponse> {
    const requestId = input.request.id;
    if (typeof requestId !== "string" && typeof requestId !== "number") {
      return invalidParams(
        input.request.id ?? null,
        "Subscription id required",
      );
    }
    if (!input.emit) {
      return {
        jsonrpc: "2.0",
        id: requestId,
        error: {
          code: -32_603,
          message: "Transport does not support subscription delivery",
        },
      };
    }
    if (this.closing) {
      return {
        jsonrpc: "2.0",
        id: requestId,
        error: {
          code: -32_603,
          message: "Subscription manager is closing",
        },
      };
    }
    const parsed = parseFilter(input.request.params?.notifications);
    if (parsed instanceof Error) {
      return invalidParams(requestId, parsed.message);
    }
    if (parsed.taskIds && !input.tasksExtensionEnabled) {
      return {
        jsonrpc: "2.0",
        id: requestId,
        error: {
          code: MCP_TASKS_CAPABILITY_REQUIRED,
          message: "Missing required client capability",
          data: {
            requiredCapabilities: {
              extensions: {
                "io.modelcontextprotocol/tasks": {},
              },
            },
          },
        },
      };
    }
    if (
      this.active.size + this.pendingSubscriptions >=
      MAX_ACTIVE_SUBSCRIPTIONS
    ) {
      return {
        jsonrpc: "2.0",
        id: requestId,
        error: {
          code: -32_603,
          message: "Server at capacity: too many active subscriptions",
        },
      };
    }

    this.pendingSubscriptions += 1;
    let finishRegistration!: () => void;
    const registration = new Promise<void>((resolve) => {
      finishRegistration = resolve;
    });
    this.pendingRegistrations.add(registration);
    let acceptedTaskIds: string[];
    try {
      acceptedTaskIds = parsed.taskIds
        ? await this.tasks.selectObservableTaskIds(
            parsed.taskIds,
            input.principalId,
          )
        : [];
    } finally {
      this.pendingSubscriptions -= 1;
      this.pendingRegistrations.delete(registration);
      finishRegistration();
    }
    if (this.closing) {
      return {
        jsonrpc: "2.0",
        id: requestId,
        error: {
          code: -32_603,
          message: "Subscription manager is closing",
        },
      };
    }
    let resolveClosure!: (serverInitiated: boolean) => void;
    const closure = new Promise<boolean>((resolve) => {
      resolveClosure = resolve;
    });
    const subscription: ActiveSubscription = {
      internalId: randomUUID(),
      requestId,
      taskIds: new Set(acceptedTaskIds),
      acknowledged: false,
      queuedTasks: new Map(),
      emitTail: Promise.resolve(),
      emit: input.emit,
      resolveClosure,
      closure,
      closed: false,
    };
    this.active.set(subscription.internalId, subscription);
    this.indexSubscription(subscription);

    const abort = (): void => this.close(subscription, false);
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    try {
      if (!subscription.closed) {
        await this.enqueue(subscription, {
          jsonrpc: "2.0",
          method: "notifications/subscriptions/acknowledged",
          params: {
            _meta: subscriptionMeta(requestId),
            notifications:
              acceptedTaskIds.length > 0 ? { taskIds: acceptedTaskIds } : {},
          },
        });
        const currentTasks = await this.tasks.readObservableTasks(
          acceptedTaskIds,
          input.principalId,
        );
        for (const task of currentTasks) {
          const queued = subscription.queuedTasks.get(task.taskId);
          subscription.queuedTasks.set(
            task.taskId,
            queued ? laterTaskView(queued, task) : task,
          );
        }
        const pending = [...subscription.queuedTasks.values()];
        subscription.queuedTasks.clear();
        subscription.acknowledged = true;
        for (const task of pending) this.queueTask(subscription, task);
        await subscription.taskPump;
        await subscription.emitTail;
      }
      await closure;
      await subscription.taskPump;
      await subscription.emitTail;
      // The transport suppresses this result when client cancellation has
      // already aborted the request signal.
      return {
        jsonrpc: "2.0",
        id: requestId,
        result: {
          resultType: "complete",
          _meta: subscriptionMeta(requestId),
        },
      };
    } finally {
      input.signal?.removeEventListener("abort", abort);
      this.unindexSubscription(subscription);
      this.active.delete(subscription.internalId);
    }
  }

  async closeAll(): Promise<void> {
    this.closing = true;
    await Promise.all(this.pendingRegistrations);
    const closures: Promise<void>[] = [];
    for (const subscription of this.active.values()) {
      this.close(subscription, true);
      closures.push(
        Promise.resolve(subscription.taskPump).then(
          () => subscription.emitTail,
        ),
      );
    }
    await Promise.all(closures);
  }

  dispose(): void {
    this.unsubscribeTasks();
  }

  private publishTask(task: ModernMcpDetailedTask): void {
    const subscriptionIds = this.subscriptionsByTask.get(task.taskId);
    if (!subscriptionIds) return;
    for (const subscriptionId of subscriptionIds) {
      const subscription = this.active.get(subscriptionId);
      if (!subscription || subscription.closed) continue;
      if (!subscription.acknowledged) {
        subscription.queuedTasks.set(task.taskId, task);
        continue;
      }
      this.queueTask(subscription, task);
    }
  }

  private indexSubscription(subscription: ActiveSubscription): void {
    for (const taskId of subscription.taskIds) {
      const existing = this.subscriptionsByTask.get(taskId);
      if (existing) existing.add(subscription.internalId);
      else {
        this.subscriptionsByTask.set(
          taskId,
          new Set([subscription.internalId]),
        );
      }
    }
  }

  private unindexSubscription(subscription: ActiveSubscription): void {
    for (const taskId of subscription.taskIds) {
      const existing = this.subscriptionsByTask.get(taskId);
      if (!existing) continue;
      existing.delete(subscription.internalId);
      if (existing.size === 0) this.subscriptionsByTask.delete(taskId);
    }
  }

  private enqueue(
    subscription: ActiveSubscription,
    message: JsonRpcServerMessage,
  ): Promise<void> {
    const delivery = subscription.emitTail.then(() =>
      subscription.emit(message),
    );
    subscription.emitTail = delivery.then(
      () => undefined,
      (error: unknown) => {
        this.close(subscription, false);
        throw error;
      },
    );
    return subscription.emitTail;
  }

  /**
   * Coalesce task fanout by task id while a slow transport is writing.
   * At most one queued view per selected task plus one in-flight message is
   * retained; newer state replaces older state in causal publish order.
   */
  private queueTask(
    subscription: ActiveSubscription,
    task: ModernMcpDetailedTask,
  ): void {
    if (subscription.closed) return;
    const current = subscription.queuedTasks.get(task.taskId);
    subscription.queuedTasks.set(
      task.taskId,
      current ? laterTaskView(current, task, "right") : task,
    );
    if (subscription.taskPump) return;
    const pump = (async () => {
      while (!subscription.closed && subscription.queuedTasks.size > 0) {
        const next = subscription.queuedTasks.entries().next().value as
          | [string, ModernMcpDetailedTask]
          | undefined;
        if (!next) break;
        subscription.queuedTasks.delete(next[0]);
        await this.enqueue(
          subscription,
          taskNotification(subscription.requestId, next[1]),
        );
      }
    })();
    subscription.taskPump = pump
      .catch(() => {
        this.close(subscription, false);
      })
      .finally(() => {
        subscription.taskPump = undefined;
        if (!subscription.closed && subscription.queuedTasks.size > 0) {
          this.queueTask(
            subscription,
            subscription.queuedTasks.values().next()
              .value as ModernMcpDetailedTask,
          );
        }
      });
  }

  private close(
    subscription: ActiveSubscription,
    serverInitiated: boolean,
  ): void {
    if (subscription.closed) return;
    subscription.closed = true;
    subscription.resolveClosure(serverInitiated);
  }
}

function laterTaskView(
  left: ModernMcpDetailedTask,
  right: ModernMcpDetailedTask,
  equalPreference: "left" | "right" = "left",
): ModernMcpDetailedTask {
  const leftTime = Date.parse(left.lastUpdatedAt);
  const rightTime = Date.parse(right.lastUpdatedAt);
  if (leftTime !== rightTime) return leftTime > rightTime ? left : right;
  if (isTerminalTaskView(left) !== isTerminalTaskView(right)) {
    return isTerminalTaskView(left) ? left : right;
  }
  // The only caller passes the live event as `left` and an earlier snapshot
  // as `right`. ISO timestamps have millisecond precision, so equal timestamps
  // do not imply equal state. Preserve the causally later live event.
  return equalPreference === "left" ? left : right;
}

function isTerminalTaskView(task: ModernMcpDetailedTask): boolean {
  return (
    task.status === "completed" ||
    task.status === "failed" ||
    task.status === "cancelled"
  );
}

function parseFilter(value: unknown): SubscriptionFilter | Error {
  if (!isRecord(value)) {
    return new Error("notifications must be an object");
  }
  for (const key of [
    "toolsListChanged",
    "promptsListChanged",
    "resourcesListChanged",
  ] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      return new Error(`${key} must be a boolean`);
    }
  }
  const resourceSubscriptions = stringArray(
    value.resourceSubscriptions,
    "resourceSubscriptions",
  );
  if (resourceSubscriptions instanceof Error) return resourceSubscriptions;
  const taskIds = taskIdArray(value.taskIds);
  if (taskIds instanceof Error) return taskIds;
  return {
    ...(value.toolsListChanged === true ? { toolsListChanged: true } : {}),
    ...(value.promptsListChanged === true ? { promptsListChanged: true } : {}),
    ...(value.resourcesListChanged === true
      ? { resourcesListChanged: true }
      : {}),
    ...(resourceSubscriptions ? { resourceSubscriptions } : {}),
    ...(taskIds ? { taskIds } : {}),
  };
}

function stringArray(
  value: unknown,
  name: string,
): string[] | undefined | Error {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    return new Error(`${name} must be an array of strings`);
  }
  return [...new Set(value)];
}

function taskIdArray(value: unknown): string[] | undefined | Error {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    return new Error("taskIds must be an array of strings");
  }
  if (value.length > MAX_MCP_TASK_IDS_PER_SUBSCRIPTION) {
    return new Error(
      `taskIds must contain at most ${MAX_MCP_TASK_IDS_PER_SUBSCRIPTION} entries`,
    );
  }
  if (!value.every((entry) => typeof entry === "string")) {
    return new Error("taskIds must be an array of strings");
  }
  const invalid = value.find((entry) => !isModernMcpTaskId(entry));
  if (invalid !== undefined) {
    return new Error("taskIds entries must be UUIDv4 task identifiers");
  }
  return [...new Set(value)];
}

function taskNotification(
  subscriptionId: string | number,
  task: ModernMcpDetailedTask,
): JsonRpcServerMessage {
  return {
    jsonrpc: "2.0",
    method: "notifications/tasks",
    params: {
      ...task,
      _meta: subscriptionMeta(subscriptionId),
    },
  };
}

function subscriptionMeta(
  subscriptionId: string | number,
): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/subscriptionId": subscriptionId,
  };
}

function invalidParams(
  id: JsonRpcResponse["id"],
  message: string,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32_602, message },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
