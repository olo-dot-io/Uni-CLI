/**
 * @owner       src/browser/snapshot-helpers.ts
 * @does        Pair each DOM snapshot with the fingerprint map required for subsequent ref verification.
 * @needs       src/browser/snapshot.ts, snapshot-identity.ts, src/types.ts
 * @feeds       BrowserPage.snapshot, BrowserBrokerPage.snapshot, pipeline and operator ref actions
 * @breaks      Snapshot, fingerprint persistence, or request cancellation rejects the snapshot so callers never receive unusable refs.
 * @invariants  A returned snapshot always has a successfully persisted fingerprint from the same page turn; cancellation reaches both renderer evaluations and prevents a post-cancel fingerprint mutation when snapshot evaluation finishes late.
 * @side-effects Evaluates snapshot and fingerprint scripts in the target renderer.
 * @perf        Two sequential renderer evaluations per snapshot.
 * @concurrency Page/broker target serialization prevents mutations from interleaving within one target command queue.
 * @test        tests/unit/browser-snapshot-helpers.test.ts, tests/unit/browser/target-errors.test.ts
 * @stability   experimental
 * @since       2026-04-24
 */

import type { IPage, SnapshotOptions } from "../types.js";
import { generateSnapshotJs } from "./snapshot.js";
import { FINGERPRINT_PERSIST_JS } from "./snapshot-identity.js";

export async function snapshotWithFingerprint(
  page: IPage,
  opts?: SnapshotOptions,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const js = generateSnapshotJs(opts);
  const result = await page.evaluate(js, signal);
  signal?.throwIfAborted();
  await page.evaluate(FINGERPRINT_PERSIST_JS, signal);
  signal?.throwIfAborted();
  return (result as string) ?? "";
}
