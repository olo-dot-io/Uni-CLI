/**
 * Snapshot helper that pairs a DOM snapshot with the ref-locator fingerprint
 * map. Used by both `BrowserPage.snapshot()` and `DaemonPage.snapshot()` so
 * pipeline and interactive (`unicli operate`) surfaces get ref verification
 * for free. Lives outside page.ts / bridge.ts to keep both under the
 * complexity-gate line budget.
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
  try {
    await page.evaluate(FINGERPRINT_PERSIST_JS);
  } catch {
    // Page may have navigated; stale-ref detection handles this later.
  }
  return (result as string) ?? "";
}
