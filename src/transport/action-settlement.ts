/**
 * @owner       src::transport::action-settlement
 * @does        Linearize one dispatched transport action against cancellation without overwriting an authoritative fulfillment.
 * @needs       AbortSignal and contained-process outcome errors
 * @feeds       mutating transport adapter action shells
 * @breaks      A post-fulfillment abort can hide committed success; a cancellation-caused rejection after dispatch can be replayed unless marked outcome-ambiguous.
 * @invariants  Pre-dispatch cancellation stays exact; fulfillment wins once settled; cancellation-caused rejection after mutating dispatch is non-retryable outcome ambiguity.
 * @side-effects Invokes exactly one supplied dispatch function.
 * @perf        One promise boundary and no timers or retained global state.
 * @concurrency Settlement follows JavaScript promise ordering and never consults process-global request state.
 * @test        compute cascade and transport adapter cancellation regression suites
 * @stability   stable
 * @since       2026-07-15
 */

import {
  isOperationOutcomeAmbiguousError,
  OperationOutcomeAmbiguousError,
} from "./contained-process.js";

export async function settleDispatchedAction<T>(
  operation: string,
  canMutate: boolean,
  signal: AbortSignal | undefined,
  dispatch: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  try {
    return await dispatch();
  } catch (error) {
    if (isOperationOutcomeAmbiguousError(error)) throw error;
    if (!signal?.aborted || !isCancellationCompletion(error, signal)) {
      throw error;
    }
    if (canMutate) {
      throw new OperationOutcomeAmbiguousError(operation, signal.reason);
    }
    throw signal.reason;
  }
}

function isCancellationCompletion(
  error: unknown,
  signal: AbortSignal,
): boolean {
  return (
    error === signal.reason ||
    (error instanceof Error && error.name === "AbortError")
  );
}
