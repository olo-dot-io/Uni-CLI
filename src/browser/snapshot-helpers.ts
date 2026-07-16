/**
 * @owner       src/browser/snapshot-helpers.ts
 * @does        Execute one DOM snapshot script whose result and capability-scoped ref registries commit atomically.
 * @needs       node:crypto, src/browser/snapshot.ts, src/types.ts
 * @feeds       BrowserPage.snapshot, BrowserBrokerPage.snapshot, pipeline and operator ref actions
 * @breaks      Snapshot, registry persistence, or request cancellation rejects so callers never receive unusable refs.
 * @invariants  A returned snapshot and its ref registries come from one renderer evaluation with one unguessable snapshot id; cancellation prevents returning late results.
 * @side-effects Evaluates one snapshot/registry script in the target renderer.
 * @perf        One renderer evaluation per snapshot.
 * @concurrency Page/broker target serialization prevents mutations from interleaving within one target command queue.
 * @test        tests/unit/browser-snapshot-helpers.test.ts, tests/unit/browser/target-errors.test.ts
 * @stability   experimental
 * @since       2026-04-24
 */

import { randomUUID } from "node:crypto";

import type { IPage, SnapshotOptions } from "../types.js";
import { generateSnapshotJs } from "./snapshot.js";

export async function snapshotWithFingerprint(
  page: IPage,
  opts?: SnapshotOptions,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const js = generateSnapshotJs(opts, randomUUID());
  const result = await page.evaluate(js, signal);
  signal?.throwIfAborted();
  return (result as string) ?? "";
}
