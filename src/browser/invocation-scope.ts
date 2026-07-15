/**
 * @owner       src/browser/invocation-scope.ts
 * @does        Carry one validated browser invocation identity/provider policy and its turn-finalization hooks through asynchronous CLI/MCP execution without mutating process-global state.
 * @needs       node:async_hooks, src/browser/invocation-context.ts, runtime-session.ts
 * @feeds       src/browser/bridge.ts, src/commands/browser/runtime.ts, src/mcp/handler.ts, browser-backed engine steps
 * @breaks      BrowserInvocationScopeError on invalid provider/visibility combinations or conflicting profile partitions.
 * @invariants  One async call chain observes one immutable scope; hidden maps only to managed/remote providers and Chrome maps only to background/foreground.
 * @side-effects Stores context in Node AsyncLocalStorage and runs registered turn finalizers at the owning invocation boundary.
 * @perf        O(1) context lookup; no serialization or process-global environment writes.
 * @concurrency Concurrent calls retain independent scopes, including after awaits and nested async work.
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
}

export interface BrowserInvocationScopeInput {
  context: BrowserInvocationContext;
  provider?: BrowserProvider;
  visibility?: BrowserVisibility;
  profilePartitionId?: string;
  isolated?: boolean;
  ephemeral?: boolean;
  profileId?: string;
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
  turnFinalizers: Map<string, () => Promise<void>>;
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
  const profilePartitionId = normalizeIdentity(
    input.profilePartitionId ??
      input.context.profile_partition_id ??
      input.context.agent_session_id,
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
  });
}

export function runWithBrowserInvocationScope<T>(
  scope: BrowserInvocationScope,
  operation: () => T,
): T {
  return invocationStorage.run({ scope, turnFinalizers: new Map() }, operation);
}

export async function runBrowserInvocation<T>(
  scope: BrowserInvocationScope,
  operation: () => Promise<T>,
): Promise<T> {
  return invocationStorage.run(
    { scope, turnFinalizers: new Map() },
    async () => {
      let operationResult: T | undefined;
      let operationError: unknown;
      try {
        operationResult = await operation();
      } catch (error) {
        operationError = error;
      }
      const finalizerErrors = await finalizeInvocationTurns();
      if (operationError !== undefined && finalizerErrors.length > 0) {
        throw new AggregateError(
          [operationError, ...finalizerErrors],
          "Browser invocation and turn finalization both failed",
        );
      }
      if (operationError !== undefined) throw operationError;
      if (finalizerErrors.length === 1) throw finalizerErrors[0];
      if (finalizerErrors.length > 1) {
        throw new AggregateError(
          finalizerErrors,
          "Browser turn finalization failed",
        );
      }
      return operationResult as T;
    },
  );
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
  invocationStorage.getStore()?.turnFinalizers.set(key, finalizer);
}

async function finalizeInvocationTurns(): Promise<unknown[]> {
  const store = invocationStorage.getStore();
  if (!store) return [];
  const finalizers = [...store.turnFinalizers.values()].reverse();
  store.turnFinalizers.clear();
  const outcomes = await Promise.allSettled(
    finalizers.map((finalizer) => finalizer()),
  );
  return outcomes
    .filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    )
    .map((outcome) => outcome.reason);
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
