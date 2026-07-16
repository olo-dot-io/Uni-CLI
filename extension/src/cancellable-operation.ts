/**
 * @owner       extension/src/cancellable-operation.ts
 * @does        Race one Chrome operation against request cancellation without leaving an unhandled late completion.
 * @needs       AbortSignal, DOMException
 * @feeds       background-supervisor.ts, chrome-controller.ts
 * @breaks      Cancellation rejects with the signal reason while the already-dispatched Chrome promise is safely ignored when it settles late.
 * @invariants  Cancellation never waits for an uncooperative Chrome promise; the underlying promise always has a rejection sink; listeners are removed at the public settle boundary.
 * @side-effects Registers one temporary abort listener.
 * @perf        One promise race per cancellable Chrome operation.
 * @concurrency The request signal wins independently of later Chrome completion order.
 * @test        tests/integration/browser-extension-background.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

export async function raceWithCancellation<T>(
  execute: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return execute();
  signal.throwIfAborted();
  const execution = Promise.resolve().then(execute);
  void execution.catch(() => undefined);
  let rejectCancellation!: (reason: unknown) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const abort = (): void => {
    rejectCancellation(
      signal.reason ??
        new DOMException("Chrome command cancelled", "AbortError"),
    );
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await Promise.race([execution, cancellation]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
