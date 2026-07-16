/**
 * @owner       src/browser/invocation-scope.ts
 * @does        Carry one validated browser invocation identity/provider policy, cancellation signal, and grouped turn-finalization hooks through asynchronous CLI/MCP execution without mutating process-global state.
 * @needs       node:async_hooks, src/browser/invocation-context.ts, runtime-session.ts
 * @feeds       src/browser/bridge.ts, src/commands/browser/runtime.ts, src/mcp/handler.ts, browser-backed engine steps
 * @breaks      BrowserInvocationScopeError on invalid provider/visibility combinations or conflicting profile partitions.
 * @invariants  One async call chain observes one immutable scope; omitted partitions share the explicit default runtime while Agent session identity still isolates targets; every participant prepares at most once before one idempotent lifecycle finalizer ends a logical turn; an explicit session finalizer can never be downgraded by a late turn participant; retryable finalizer failures receive one immediate retry and remain explicitly retryable; cancellation starts each turn group exactly once without overwriting an authoritative operation fulfillment; hidden maps only to managed/remote providers and Chrome maps only to background/foreground.
 * @side-effects Stores context in Node AsyncLocalStorage and runs registered turn finalizers at cancellation or the owning invocation boundary.
 * @perf        O(1) context lookup; no serialization or process-global environment writes.
 * @concurrency Concurrent calls retain independent scopes, including after awaits and nested async work; same-turn participants share one idempotent finalization promise.
 * @test        tests/unit/browser-invocation-scope.test.ts, tests/unit/mcp/tools.test.ts, tests/unit/commands/browser.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { BrowserInvocationContext } from "./invocation-context.js";
import type { BrowserVisibility } from "./runtime-session.js";

export type BrowserProvider = "managed" | "chrome" | "remote";

export interface BrowserInvocationScope {
  readonly context: BrowserInvocationContext;
  readonly provider: BrowserProvider;
  readonly visibility: BrowserVisibility;
  readonly profilePartitionId: string;
  readonly isolated: boolean;
  readonly ephemeral: boolean;
  readonly profileId?: string;
  readonly signal?: AbortSignal;
}

export interface BrowserInvocationScopeInput {
  context: BrowserInvocationContext;
  provider?: BrowserProvider;
  visibility?: BrowserVisibility;
  profilePartitionId?: string;
  isolated?: boolean;
  ephemeral?: boolean;
  profileId?: string;
  signal?: AbortSignal;
}

export class BrowserInvocationScopeError extends Error {
  readonly code = "browser_invocation_scope_invalid";
  readonly suggestion =
    "Select managed/remote with hidden visibility, or Chrome with explicit background/foreground visibility.";

  constructor(message: string) {
    super(message);
    this.name = "BrowserInvocationScopeError";
  }
}

interface BrowserInvocationStore {
  scope: BrowserInvocationScope;
  turnFinalizers: Map<string, BrowserTurnFinalizerGroup>;
  finalizerPromises: Set<Promise<void>>;
  state: "open" | "finalizing" | "finalized";
}

interface BrowserTurnFinalizerGroup {
  finalizer: () => Promise<void>;
  finalizerDisposition: "turn" | "session";
  preparations: Set<() => Promise<void>>;
  startedPreparations: Set<() => Promise<void>>;
  state: "open" | "preparing" | "sealed" | "retryable" | "finalized";
  promise: Promise<void> | null;
}

export interface BrowserTurnFinalizerHandle {
  finalize(finalizer?: () => Promise<void>): Promise<void>;
}

export class BrowserInvocationTurnEndedError extends Error {
  readonly code = "browser_turn_ended";
  readonly retryable = false;
  readonly suggestion =
    "Create a new browser invocation with a new turn id before connecting another page.";

  constructor(key: string) {
    super(`Browser turn ${key} is already ending`);
    this.name = "BrowserInvocationTurnEndedError";
  }
}

const invocationStorage = new AsyncLocalStorage<BrowserInvocationStore>();

export function createBrowserInvocationScope(
  input: BrowserInvocationScopeInput,
): BrowserInvocationScope {
  const provider = input.provider ?? "managed";
  const visibility = input.visibility ?? defaultVisibility(provider);
  assertVisibility(provider, visibility);
  if (provider !== "managed" && input.ephemeral === true) {
    throw new BrowserInvocationScopeError(
      `Provider ${provider} does not own a local automation profile and cannot be ephemeral`,
    );
  }
  if (provider !== "managed" && input.profileId) {
    throw new BrowserInvocationScopeError(
      `Provider ${provider} does not accept a managed automation profile id`,
    );
  }
  if (provider !== "managed" && input.isolated === true) {
    throw new BrowserInvocationScopeError(
      `Provider ${provider} does not accept the managed-only isolated-context option`,
    );
  }
  if (input.ephemeral === true && input.profileId) {
    throw new BrowserInvocationScopeError(
      "An ephemeral managed browser cannot also select a persistent profile id",
    );
  }
  const profilePartitionId = normalizeIdentity(
    input.profilePartitionId ?? input.context.profile_partition_id ?? "default",
    "profile partition",
  );
  if (
    input.context.profile_partition_id &&
    input.context.profile_partition_id !== profilePartitionId
  ) {
    throw new BrowserInvocationScopeError(
      `Invocation context partition ${input.context.profile_partition_id} conflicts with ${profilePartitionId}`,
    );
  }
  return Object.freeze({
    context: Object.freeze({ ...input.context }),
    provider,
    visibility,
    profilePartitionId,
    isolated: input.isolated === true,
    ephemeral: input.ephemeral === true,
    ...(input.profileId
      ? { profileId: normalizeIdentity(input.profileId, "profile") }
      : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

export async function runBrowserInvocation<T>(
  scope: BrowserInvocationScope,
  operation: () => Promise<T>,
): Promise<T> {
  const store: BrowserInvocationStore = {
    scope,
    turnFinalizers: new Map(),
    finalizerPromises: new Set(),
    state: "open",
  };
  return invocationStorage.run(store, async () => {
    const startFinalizers = () => startInvocationFinalizers(store);
    scope.signal?.addEventListener("abort", startFinalizers, { once: true });
    if (scope.signal?.aborted) startFinalizers();
    try {
      let operationFailed = false;
      let operationResult: T | undefined;
      let operationError: unknown;
      try {
        scope.signal?.throwIfAborted();
        operationResult = await operation();
      } catch (error) {
        operationFailed = true;
        operationError = error;
      }
      const finalizerErrors = await finalizeInvocationTurns(store);
      if (operationFailed && finalizerErrors.length > 0) {
        throw new AggregateError(
          [operationError, ...finalizerErrors],
          "Browser invocation and turn finalization both failed",
        );
      }
      if (operationFailed) throw operationError;
      if (finalizerErrors.length === 1) throw finalizerErrors[0];
      if (finalizerErrors.length > 1) {
        throw new AggregateError(
          finalizerErrors,
          "Browser turn finalization failed",
        );
      }
      return operationResult as T;
    } finally {
      scope.signal?.removeEventListener("abort", startFinalizers);
    }
  });
}

export function currentBrowserInvocationScope():
  | BrowserInvocationScope
  | undefined {
  return invocationStorage.getStore()?.scope;
}

export function registerBrowserTurnFinalizer(
  key: string,
  finalizer: () => Promise<void>,
): void {
  const store = invocationStorage.getStore();
  if (!store) return;
  const group = store.turnFinalizers.get(key);
  if (group) {
    if (group.state !== "open") {
      throw new BrowserInvocationTurnEndedError(key);
    }
    group.finalizer = finalizer;
  } else {
    if (store.state !== "open") {
      throw new BrowserInvocationTurnEndedError(key);
    }
    store.turnFinalizers.set(key, {
      finalizer,
      finalizerDisposition: "turn",
      preparations: new Set(),
      startedPreparations: new Set(),
      state: "open",
      promise: null,
    });
  }
  if (store.scope.signal?.aborted) startInvocationFinalizers(store);
}

export async function registerBrowserTurnParticipant(
  key: string,
  prepare: () => Promise<void>,
  finalizer: () => Promise<void>,
): Promise<BrowserTurnFinalizerHandle | undefined> {
  const store = invocationStorage.getStore();
  if (!store) return undefined;
  let group = store.turnFinalizers.get(key);
  if (!group) {
    if (store.state !== "open") {
      await prepare();
      throw new BrowserInvocationTurnEndedError(key);
    }
    group = {
      finalizer,
      finalizerDisposition: "turn",
      preparations: new Set(),
      startedPreparations: new Set(),
      state: "open",
      promise: null,
    };
    store.turnFinalizers.set(key, group);
  } else {
    if (
      group.state === "sealed" ||
      group.state === "retryable" ||
      group.state === "finalized"
    ) {
      await prepare();
      throw new BrowserInvocationTurnEndedError(key);
    }
    if (group.finalizerDisposition === "turn") group.finalizer = finalizer;
  }
  group.preparations.add(prepare);
  const registeredGroup = group;
  const handle: BrowserTurnFinalizerHandle = {
    finalize: (override) => {
      if (
        override &&
        (registeredGroup.state === "open" ||
          registeredGroup.state === "preparing" ||
          registeredGroup.state === "retryable")
      ) {
        registeredGroup.finalizer = override;
        registeredGroup.finalizerDisposition = "session";
      }
      return startTurnFinalizer(store, key, registeredGroup);
    },
  };
  if (store.scope.signal?.aborted) startInvocationFinalizers(store);
  return handle;
}

function startInvocationFinalizers(store: BrowserInvocationStore): void {
  if (store.state === "open") store.state = "finalizing";
  const groups = [...store.turnFinalizers.entries()].reverse();
  for (const [key, group] of groups) {
    void startTurnFinalizer(store, key, group);
  }
}

function startTurnFinalizer(
  store: BrowserInvocationStore,
  key: string,
  group: BrowserTurnFinalizerGroup,
): Promise<void> {
  if (store.turnFinalizers.get(key) !== group) {
    throw new Error(`Browser turn finalizer identity changed for ${key}`);
  }
  if (group.state === "open") group.state = "preparing";
  if (group.state === "finalized" && group.promise === null) {
    return Promise.resolve();
  }
  if (group.promise) return group.promise;
  const execution = runTurnFinalizerGroup(group);
  group.promise = execution;
  execution.then(
    () => undefined,
    () => {
      if (group.state === "retryable" && group.promise === execution) {
        group.promise = null;
      }
    },
  );
  execution.catch(() => undefined);
  store.finalizerPromises.add(execution);
  return execution;
}

async function runTurnFinalizerGroup(
  group: BrowserTurnFinalizerGroup,
): Promise<void> {
  const errors: unknown[] = [];
  if (group.state !== "retryable") {
    while (true) {
      const pending = [...group.preparations].filter(
        (prepare) => !group.startedPreparations.has(prepare),
      );
      if (pending.length === 0) {
        group.state = "sealed";
        break;
      }
      for (const prepare of pending) group.startedPreparations.add(prepare);
      const outcomes = await Promise.allSettled(
        pending.map((prepare) => prepare()),
      );
      errors.push(
        ...outcomes
          .filter(
            (outcome): outcome is PromiseRejectedResult =>
              outcome.status === "rejected",
          )
          .map((outcome) => outcome.reason),
      );
    }
  } else {
    group.state = "sealed";
  }
  let finalizerError: unknown;
  try {
    await runLifecycleFinalizer(group.finalizer);
    group.state = "finalized";
  } catch (error) {
    finalizerError = error;
    group.state = isRetryableLifecycleError(error) ? "retryable" : "finalized";
  }
  if (finalizerError !== undefined) errors.push(finalizerError);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Browser turn participant cleanup failed");
  }
}

async function runLifecycleFinalizer(
  finalizer: () => Promise<void>,
): Promise<void> {
  try {
    await finalizer();
  } catch (error) {
    if (!isRetryableLifecycleError(error)) throw error;
    await finalizer();
  }
}

function isRetryableLifecycleError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    (error as { retryable?: unknown }).retryable === true
  );
}

async function finalizeInvocationTurns(
  store: BrowserInvocationStore,
): Promise<unknown[]> {
  startInvocationFinalizers(store);
  try {
    const outcomes = await Promise.allSettled(store.finalizerPromises);
    return outcomes
      .filter(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      )
      .map((outcome) => outcome.reason);
  } finally {
    store.state = "finalized";
  }
}

function defaultVisibility(provider: BrowserProvider): BrowserVisibility {
  return provider === "chrome" ? "background" : "hidden";
}

function assertVisibility(
  provider: BrowserProvider,
  visibility: BrowserVisibility,
): void {
  if (provider === "chrome" && visibility === "hidden") {
    throw new BrowserInvocationScopeError(
      "Chrome uses an existing visible browser and cannot guarantee hidden visibility",
    );
  }
  if (provider !== "chrome" && visibility !== "hidden") {
    throw new BrowserInvocationScopeError(
      `Provider ${provider} has no foreground window and requires hidden visibility`,
    );
  }
}

function normalizeIdentity(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new BrowserInvocationScopeError(`${label} id must not be empty`);
  }
  if (normalized.length > 512 || /\p{Cc}/u.test(normalized)) {
    throw new BrowserInvocationScopeError(
      `${label} id must be at most 512 characters without control characters`,
    );
  }
  return normalized;
}
