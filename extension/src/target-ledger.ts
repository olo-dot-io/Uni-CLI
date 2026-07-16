/**
 * @owner       extension/src/target-ledger.ts
 * @does        Persist Chrome task-target ownership and pre-allocation intents across MV3 service-worker restarts, then reconcile them against live tabs.
 * @needs       chrome.storage.session, chrome.tabs, extension/src/browser-session.ts, src/browser/chrome-native-protocol.ts
 * @feeds       extension/src/background.ts, extension/src/chrome-controller.ts
 * @breaks      Throws when ledger storage is malformed/unavailable so allocation cannot report success without durable recovery evidence.
 * @invariants  An owned tab intent is durable before creation and is never discarded while its Chrome API call may still complete; a successful allocation/claim is durable before its result; missing completed targets are removed during reconciliation.
 * @side-effects Reads/writes Chrome session storage and queries live tabs.
 * @perf        One serialized storage read/write per lifecycle transition; reconciliation is O(open tabs + ledger entries) on native-host connect.
 * @concurrency All ledger mutations share one promise tail so tab-removal events and native commands cannot lose updates.
 * @test        tests/integration/browser-extension-background.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import {
  chromeTargetId,
  type ChromeNativeTarget,
} from "../../src/browser/chrome-native-protocol.js";
import { getChromeBrowserSessionId } from "./browser-session.js";

const TARGET_LEDGER_KEY = "unicli_target_ledger_v1";
const TARGET_LEDGER_VERSION = 1;

interface AllocationIntent {
  state: "allocating";
  request_id: string;
  visibility: "background" | "foreground";
  window_id?: number;
}

interface PersistedTarget {
  state: "target";
  target: ChromeNativeTarget;
}

type TargetLedgerEntry = AllocationIntent | PersistedTarget;

interface TargetLedgerState {
  version: typeof TARGET_LEDGER_VERSION;
  entries: TargetLedgerEntry[];
}

let ledgerTail = Promise.resolve();

export function allocationMarker(requestId: string): string {
  return `about:blank#unicli-allocation=${encodeURIComponent(requestId)}`;
}

export function beginOwnedAllocation(
  requestId: string,
  visibility: "background" | "foreground",
  windowId?: number,
): Promise<void> {
  return mutateLedger((entries) => {
    const withoutRequest = entries.filter(
      (entry) => entry.state !== "allocating" || entry.request_id !== requestId,
    );
    withoutRequest.push({
      state: "allocating",
      request_id: requestId,
      visibility,
      ...(windowId === undefined ? {} : { window_id: windowId }),
    });
    return withoutRequest;
  });
}

export function commitOwnedAllocation(
  requestId: string,
  target: ChromeNativeTarget,
): Promise<void> {
  return mutateLedger((entries) => [
    ...entries.filter(
      (entry) =>
        !(
          (entry.state === "allocating" && entry.request_id === requestId) ||
          (entry.state === "target" &&
            entry.target.target_id === target.target_id)
        ),
    ),
    { state: "target", target },
  ]);
}

export function cancelOwnedAllocation(requestId: string): Promise<void> {
  return mutateLedger((entries) =>
    entries.filter(
      (entry) => entry.state !== "allocating" || entry.request_id !== requestId,
    ),
  );
}

export function rememberChromeTarget(
  target: ChromeNativeTarget,
): Promise<void> {
  return mutateLedger((entries) => [
    ...entries.filter(
      (entry) =>
        entry.state !== "target" || entry.target.target_id !== target.target_id,
    ),
    { state: "target", target },
  ]);
}

export function forgetChromeTarget(targetId: string): Promise<void> {
  return mutateLedger((entries) =>
    entries.filter(
      (entry) =>
        entry.state !== "target" || entry.target.target_id !== targetId,
    ),
  );
}

export function forgetChromeTab(tabId: number): Promise<void> {
  return mutateLedger((entries) =>
    entries.filter(
      (entry) => entry.state !== "target" || entry.target.tab_id !== tabId,
    ),
  );
}

export function readChromeTarget(
  targetId: string,
): Promise<ChromeNativeTarget | undefined> {
  return serializeLedger(async () => {
    const state = await readLedger();
    const entry = state.entries.find(
      (candidate): candidate is PersistedTarget =>
        candidate.state === "target" && candidate.target.target_id === targetId,
    );
    return entry ? structuredClone(entry.target) : undefined;
  });
}

export function reconcileChromeTargets(): Promise<ChromeNativeTarget[]> {
  return serializeLedger(async () => {
    const state = await readLedger();
    const tabs = await chrome.tabs.query({});
    const liveTabs = new Map(
      tabs
        .filter(
          (tab): tab is chrome.tabs.Tab & { id: number; windowId: number } =>
            typeof tab.id === "number" && typeof tab.windowId === "number",
        )
        .map((tab) => [tab.id, tab]),
    );
    const browserSessionId = await getChromeBrowserSessionId();
    const targets = new Map<string, ChromeNativeTarget>();
    const unresolvedIntents: AllocationIntent[] = [];
    for (const entry of state.entries) {
      if (entry.state === "target") {
        const tab = liveTabs.get(entry.target.tab_id);
        if (
          !tab ||
          entry.target.target_id !==
            chromeTargetId(browserSessionId, entry.target.tab_id)
        ) {
          continue;
        }
        targets.set(entry.target.target_id, {
          ...entry.target,
          window_id: tab.windowId,
          ...(tab.url ? { url: tab.url } : {}),
          ...(tab.title ? { title: tab.title } : {}),
        });
        continue;
      }
      const marker = allocationMarker(entry.request_id);
      const tab = [...liveTabs.values()].find(
        (candidate) => candidate.url === marker,
      );
      if (!tab) {
        unresolvedIntents.push(entry);
        continue;
      }
      const target: ChromeNativeTarget = {
        target_id: chromeTargetId(browserSessionId, tab.id),
        tab_id: tab.id,
        window_id: tab.windowId,
        owned: true,
        visibility: entry.visibility,
        ...(tab.url ? { url: tab.url } : {}),
        ...(tab.title ? { title: tab.title } : {}),
      };
      targets.set(target.target_id, target);
    }
    const reconciled = [...targets.values()].sort(
      (left, right) => left.tab_id - right.tab_id,
    );
    await writeLedger([
      ...unresolvedIntents,
      ...reconciled.map(
        (target): PersistedTarget => ({
          state: "target",
          target,
        }),
      ),
    ]);
    return reconciled;
  });
}

function mutateLedger(
  mutate: (entries: TargetLedgerEntry[]) => TargetLedgerEntry[],
): Promise<void> {
  return serializeLedger(async () => {
    const state = await readLedger();
    await writeLedger(mutate(state.entries));
  });
}

function serializeLedger<T>(operation: () => Promise<T>): Promise<T> {
  const run = ledgerTail.then(operation, operation);
  ledgerTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function readLedger(): Promise<TargetLedgerState> {
  const stored = await chrome.storage.session.get(TARGET_LEDGER_KEY);
  const value = stored[TARGET_LEDGER_KEY];
  if (value === undefined) {
    return { version: TARGET_LEDGER_VERSION, entries: [] };
  }
  if (!isTargetLedgerState(value)) {
    throw new Error("Chrome target ledger has an invalid schema");
  }
  return value;
}

async function writeLedger(entries: TargetLedgerEntry[]): Promise<void> {
  await chrome.storage.session.set({
    [TARGET_LEDGER_KEY]: {
      version: TARGET_LEDGER_VERSION,
      entries,
    } satisfies TargetLedgerState,
  });
}

function isTargetLedgerState(value: unknown): value is TargetLedgerState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.version === TARGET_LEDGER_VERSION &&
    Array.isArray(record.entries) &&
    record.entries.every(isTargetLedgerEntry)
  );
}

function isTargetLedgerEntry(value: unknown): value is TargetLedgerEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.state === "allocating") {
    return (
      typeof record.request_id === "string" &&
      (record.visibility === "background" ||
        record.visibility === "foreground") &&
      (record.window_id === undefined || isTabId(record.window_id))
    );
  }
  return record.state === "target" && isChromeTarget(record.target);
}

function isChromeTarget(value: unknown): value is ChromeNativeTarget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.target_id === "string" &&
    isTabId(record.tab_id) &&
    isTabId(record.window_id) &&
    typeof record.owned === "boolean" &&
    (record.visibility === "background" ||
      record.visibility === "foreground") &&
    (record.url === undefined || typeof record.url === "string") &&
    (record.title === undefined || typeof record.title === "string")
  );
}

function isTabId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
