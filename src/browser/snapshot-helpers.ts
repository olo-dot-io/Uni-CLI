/**
 * @owner       src/browser/snapshot-helpers.ts
 * @does        Pair each DOM snapshot with the fingerprint map required for subsequent ref verification.
 * @needs       src/browser/snapshot.ts, snapshot-identity.ts, src/types.ts
 * @feeds       BrowserPage.snapshot, BrowserBrokerPage.snapshot, pipeline and operator ref actions
 * @breaks      Snapshot or fingerprint persistence failure rejects the snapshot so callers never receive unusable refs.
 * @invariants  A returned snapshot always has a successfully persisted fingerprint from the same page turn.
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
): Promise<string> {
  const js = generateSnapshotJs(opts);
  const result = await page.evaluate(js);
  await page.evaluate(FINGERPRINT_PERSIST_JS);
  return (result as string) ?? "";
}
