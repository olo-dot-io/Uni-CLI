/**
 * @owner       extension/src/background-supervisor.ts
 * @does        Enforce failure-atomic background Chrome UI postconditions across commands, delayed navigation targets, and MV3 service-worker restarts.
 * @needs       chrome.tabs/windows/webNavigation/storage.session, target-ledger.ts, src/browser/chrome-native-protocol.ts, src/browser/runtime-protocol.ts
 * @feeds       extension/src/chrome-controller.ts, extension/src/background.ts
 * @breaks      BackgroundSupervisionError for untracked targets, claimed-tab mutation, unsafe release, malformed durable state, lineage-capacity exhaustion, incomplete compensation, or poisoned targets.
 * @invariants  Only owned background tabs may mutate page state; opener and webNavigation lineage are the sole popup attribution sources; every mutation has a durable pre-effect UI baseline; lifecycle events are retained until durable state hydration; command completion drains an epoch-stable compensation boundary; cancellation retires its root before returning and preserves a bounded durable lineage tombstone for late descendants; unrelated user tabs and focus are never closed or restored.
 * @side-effects Persists guard and violation ledgers, supervises Chrome lifecycle events, closes attributable descendants, restores attributable UI changes, and retires unsafe targets.
 * @perf        Lifecycle events share one serialized tail; compensation is O(open windows + attributable descendants) and repeats only when a new attributable epoch arrives.
 * @concurrency Listener callbacks synchronously retain lineage and dirty epochs, then one non-reentrant tail orders hydration, event effects, storage, compensation, and reconciliation.
 * @test        tests/integration/browser-extension-background.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import {
  CHROME_NATIVE_COMMAND_DEADLINE_MS,
  type ChromeNativeTarget,
} from "../../src/browser/chrome-native-protocol.js";
import type { BrowserPageCommand } from "../../src/browser/runtime-protocol.js";
import { raceWithCancellation } from "./cancellable-operation.js";
import { forgetChromeTarget } from "./target-ledger.js";

export interface ChromeUiState {
  window_ids: number[];
  focused_window_id: number | null;
  active_tabs: Array<{ window_id: number; tab_id: number }>;
}

interface CreatedTabObservation {
  tab_id: number;
  window_id: number;
  opener_tab_id: number | null;
}

interface NavigationTargetObservation {
  source_tab_id: number;
  tab_id: number;
}

interface BackgroundCompensationResult {
  attributable_tab_count: number;
  attributable_ui_changed: boolean;
}

interface BackgroundTargetGuard {
  target_id: string;
  tab_id: number;
  owned: boolean;
  safe_state: ChromeUiState;
  page_mutated: boolean;
  descendant_tab_ids: number[];
}

interface BackgroundUiViolation {
  target_id: string;
  tab_id: number;
  message: string;
  occurred_at: string;
}

interface RetiredBackgroundLineage {
  root_tab_id: number;
  safe_state: ChromeUiState;
  lineage_tab_ids: number[];
  expires_at: number;
}

interface UnresolvedUiCandidate {
  revision: number;
  state: ChromeUiState;
}

type BackgroundLifecycleEvent =
  | { type: "created"; observation: CreatedTabObservation }
  | { type: "navigation_target"; observation: NavigationTargetObservation }
  | { type: "activated"; tab_id: number; window_id: number }
  | { type: "focus_changed"; window_id: number }
  | { type: "updated"; tab_id: number; status?: string }
  | {
      type: "removed";
      tab_id: number;
      root_target_id?: string;
      descendant_root_tab_id?: number;
    };

export class BackgroundSupervisionError extends Error {
  readonly code: string;
  readonly suggestion: string;
  readonly retryable: boolean;
  readonly outcomeAmbiguous: boolean;
  readonly targetUnusable: boolean;

  constructor(
    code: string,
    message: string,
    suggestion: string,
    options: ErrorOptions & {
      retryable?: boolean;
      outcomeAmbiguous?: boolean;
      targetUnusable?: boolean;
    } = {},
  ) {
    super(message, options);
    this.name = "BackgroundSupervisionError";
    this.code = code;
    this.suggestion = suggestion;
    this.retryable = options.retryable === true;
    this.outcomeAmbiguous = options.outcomeAmbiguous === true;
    this.targetUnusable = options.targetUnusable === true;
  }
}

export class BackgroundCommandRecoveryError extends Error {
  constructor(
    readonly commandError: unknown,
    readonly backgroundError: unknown,
  ) {
    super(
      `Chrome command and background recovery failed: command=${errorMessage(commandError)} recovery=${errorMessage(backgroundError)}`,
      {
        cause: new AggregateError(
          [commandError, backgroundError],
          "Chrome command and background recovery both failed",
        ),
      },
    );
    this.name = "BackgroundCommandRecoveryError";
  }
}

const BACKGROUND_GUARDS_KEY = "unicli_background_guards_v1";
const BACKGROUND_UI_VIOLATIONS_KEY = "unicli_background_ui_violations_v1";
const RETIRED_BACKGROUND_LINEAGES_KEY = "unicli_retired_background_lineages_v1";
const MAX_COMPENSATION_ITERATIONS = 8;
const MAX_COMPENSATION_MS = 5_000;
const MAX_CONTAINMENT_ITERATIONS = 8;
const MAX_RETIRED_BACKGROUND_LINEAGES = 256;
const MAX_RETIRED_LINEAGE_TAB_IDS = 4_096;
const RETIRED_BACKGROUND_LINEAGE_TTL_MS = CHROME_NATIVE_COMMAND_DEADLINE_MS;
const PAGE_AFFECTING_COMMANDS = new Set<BrowserPageCommand["method"]>([
  "navigate",
  "evaluate",
  "click",
  "native_click",
  "type",
  "press",
  "insert_text",
  "scroll",
  "cdp",
  "set_file_input",
  "dialog_respond",
]);

const guards = new Map<number, BackgroundTargetGuard>();
const violations = new Map<string, BackgroundUiViolation>();
const retiredLineages = new Map<number, RetiredBackgroundLineage>();
const retiredRootByTabId = new Map<number, number>();
const descendants = new Map<
  number,
  { root_tab_id: number; observation?: CreatedTabObservation }
>();
const unresolvedCreatedTabs = new Map<number, CreatedTabObservation>();
const knownTabIds = new Set<number>();
const commandScopedRoots = new Set<number>();
const rootEpochs = new Map<number, number>();
const compensatedEpochs = new Map<number, number>();
const unresolvedUiCandidates = new Map<number, UnresolvedUiCandidate>();
const lifecycleEvents: BackgroundLifecycleEvent[] = [];

let supervisionTail = Promise.resolve();
let supervisorFailure: unknown;
let initialized = false;
let lifecycleDrainScheduled = false;
let unresolvedUiRevision = 0;

registerListeners();

export async function reconcileBackgroundTargetSupervision(
  targets: readonly ChromeNativeTarget[],
): Promise<ChromeNativeTarget[]> {
  return serialize(async () => {
    await ensureHydratedLocked();
    await drainLifecycleEventsLocked();
    pruneRetiredLineagesLocked();
    const liveTabs = await chrome.tabs.query({});
    const liveTabIds = new Set(
      liveTabs
        .map((tab) => tab.id)
        .filter((tabId): tabId is number => typeof tabId === "number"),
    );
    const safeTargets: ChromeNativeTarget[] = [];

    for (const target of targets) {
      if (target.visibility !== "background") {
        safeTargets.push(target);
        continue;
      }
      const guard = guards.get(target.tab_id);
      if (
        !liveTabIds.has(target.tab_id) ||
        !guard ||
        guard.target_id !== target.target_id ||
        guard.owned !== target.owned ||
        violations.has(target.target_id) ||
        (target.owned &&
          guard.safe_state.active_tabs.some(
            (active) => active.tab_id === target.tab_id,
          ))
      ) {
        await retireUnrecoverableTargetLocked(target);
        continue;
      }
      if (
        target.owned &&
        controlledUiIsActive(guard, await captureChromeUiState())
      ) {
        let compensationError: unknown;
        try {
          await compensateUntilStableLocked(
            guard.safe_state,
            guard.tab_id,
            "service-worker reconciliation",
          );
        } catch (error) {
          compensationError = error;
        }
        try {
          await retireUnrecoverableTargetLocked(target);
        } catch (retirementError) {
          throw compensationError === undefined
            ? retirementError
            : new AggregateError(
                [compensationError, retirementError],
                `Chrome background target ${target.target_id} could not be compensated or retired`,
              );
        }
        if (compensationError !== undefined) throw compensationError;
        continue;
      }
      safeTargets.push(target);
    }

    const liveTargetIds = new Set(
      safeTargets.map((target) => target.target_id),
    );
    for (const [tabId, guard] of guards) {
      if (liveTargetIds.has(guard.target_id)) continue;
      rememberRetiredLineageFromGuard(guard);
      removeGuardMemory(tabId, true);
    }
    for (const targetId of violations.keys()) {
      if (!liveTargetIds.has(targetId)) violations.delete(targetId);
    }
    await persistGuardsLocked();
    await persistViolationsLocked();
    await persistRetiredLineagesLocked();
    return safeTargets;
  });
}

export async function trackBackgroundTarget(
  target: ChromeNativeTarget,
  safeState: ChromeUiState,
): Promise<void> {
  await serialize(async () => {
    await ensureHydratedLocked();
    guards.set(target.tab_id, {
      target_id: target.target_id,
      tab_id: target.tab_id,
      owned: target.owned,
      safe_state: structuredClone(safeState),
      page_mutated: false,
      descendant_tab_ids: [],
    });
    knownTabIds.add(target.tab_id);
    unresolvedCreatedTabs.delete(target.tab_id);
    unresolvedUiCandidates.delete(target.tab_id);
    rootEpochs.set(target.tab_id, 0);
    compensatedEpochs.set(target.tab_id, 0);
    violations.delete(target.target_id);
    await persistGuardsLocked();
    await persistViolationsLocked();
  });
}

export async function assertBackgroundTargetCanFinalize(
  targetId: string,
  tabId: number,
  disposition: "close" | "release",
): Promise<void> {
  if (disposition !== "release") return;
  await serialize(async () => {
    await ensureHydratedLocked();
    const guard = requireGuardLocked(targetId, tabId);
    if (!guard.owned || !guard.page_mutated) return;
    throw new BackgroundSupervisionError(
      "background_release_unsafe",
      `Owned Chrome background target ${targetId} has executed page mutations and cannot be released while delayed page effects may still exist`,
      "Close the owned target, or explicitly foreground it before handing the tab to the user.",
    );
  });
}

export async function forgetBackgroundTargetSupervision(
  targetId: string,
  tabId: number,
): Promise<void> {
  await serialize(async () => {
    await ensureHydratedLocked();
    await forgetBackgroundTargetSupervisionLocked(targetId, tabId);
  });
}

export async function superviseBackgroundPageCommand(
  targetId: string,
  tabId: number,
  command: BrowserPageCommand,
  before: ChromeUiState,
  execute: () => Promise<unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const pageAffecting = PAGE_AFFECTING_COMMANDS.has(command.method);
  await serialize(async () => {
    await ensureHydratedLocked();
    await drainLifecycleEventsLocked();
    if (supervisorFailure !== undefined) {
      throw new BackgroundSupervisionError(
        "background_supervisor_failed",
        `Chrome background supervisor previously failed: ${errorMessage(supervisorFailure)}`,
        "Reload the Uni-CLI extension and allow durable target reconciliation to complete before continuing.",
        { cause: supervisorFailure, targetUnusable: true },
      );
    }
    const guard = requireGuardLocked(targetId, tabId);
    const violation = violations.get(targetId);
    if (violation) {
      throw new BackgroundSupervisionError(
        "background_postcondition_failed",
        violation.message,
        "Uni-CLI is invalidating this Chrome target; continue on a fresh background target or use explicit foreground visibility.",
        { targetUnusable: true },
      );
    }
    if (pageAffecting && !guard.owned) {
      throw new BackgroundSupervisionError(
        "background_mutation_requires_foreground",
        `Chrome tab ${String(tabId)} is user-owned; background mode permits observation but not page mutation`,
        "Use explicit foreground visibility to mutate a claimed tab, or allocate a Uni-CLI-owned background target.",
      );
    }
    if (pageAffecting) {
      guard.page_mutated = true;
      guard.safe_state = structuredClone(before);
      await persistGuardsLocked();
    }
    commandScopedRoots.add(tabId);
  });

  const commandCreatedTabs = new Map<number, CreatedTabObservation>();
  const onCreated = (tab: chrome.tabs.Tab): void => {
    if (typeof tab.id !== "number" || typeof tab.windowId !== "number") return;
    commandCreatedTabs.set(tab.id, observationFromTab(tab));
  };
  chrome.tabs.onCreated.addListener(onCreated);
  let result: unknown;
  let commandError: unknown;
  try {
    result = await raceWithCancellation(execute, signal);
  } catch (error) {
    commandError = error;
  } finally {
    chrome.tabs.onCreated.removeListener(onCreated);
  }

  let backgroundError: unknown;
  let compensation: BackgroundCompensationResult = {
    attributable_tab_count: 0,
    attributable_ui_changed: false,
  };
  try {
    compensation = await serialize(async () => {
      await drainLifecycleEventsLocked();
      try {
        return await compensateUntilStableLocked(
          before,
          tabId,
          `page.${command.method}`,
          commandCreatedTabs,
          signal,
        );
      } catch (error) {
        const guard = guards.get(tabId);
        if (guard) {
          await recordViolationLocked({
            target_id: guard.target_id,
            tab_id: guard.tab_id,
            message: `Chrome background page.${command.method} recovery was incomplete: ${errorMessage(error)}`,
            occurred_at: new Date().toISOString(),
          });
        }
        throw error;
      } finally {
        commandScopedRoots.delete(tabId);
      }
    });
  } catch (error) {
    backgroundError = error;
    commandScopedRoots.delete(tabId);
  }

  if (commandError !== undefined) {
    if (backgroundError !== undefined) {
      throw new BackgroundCommandRecoveryError(commandError, backgroundError);
    }
    throw commandError;
  }
  if (backgroundError !== undefined) throw backgroundError;
  if (compensation.attributable_ui_changed) {
    throw new BackgroundSupervisionError(
      "background_postcondition_failed",
      `Chrome background page.${command.method} activated, focused, or created browser UI (${String(compensation.attributable_tab_count)} attributable popup tab(s)); Uni-CLI compensated the attributable change`,
      "Use explicit foreground visibility when the intended action changes visible Chrome UI.",
      { outcomeAmbiguous: pageAffecting },
    );
  }
  return result;
}

export async function captureChromeUiState(): Promise<ChromeUiState> {
  const windows = (await chrome.windows.getAll()).filter(
    (window): window is chrome.windows.Window & { id: number } =>
      typeof window.id === "number",
  );
  const windowIds = windows.map((window) => window.id).sort((a, b) => a - b);
  const browserWindowIds = new Set(windowIds);
  const activeTabs = (await chrome.tabs.query({ active: true }))
    .filter(
      (tab): tab is chrome.tabs.Tab & { id: number; windowId: number } =>
        typeof tab.id === "number" &&
        typeof tab.windowId === "number" &&
        browserWindowIds.has(tab.windowId),
    )
    .map((tab) => ({ window_id: tab.windowId, tab_id: tab.id }))
    .sort(
      (left, right) =>
        left.window_id - right.window_id || left.tab_id - right.tab_id,
    );
  return {
    window_ids: windowIds,
    focused_window_id: windows.find((window) => window.focused)?.id ?? null,
    active_tabs: activeTabs,
  };
}

export async function assertChromeUiStateUnchanged(
  before: ChromeUiState,
  action: string,
): Promise<void> {
  const after = await captureChromeUiState();
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new BackgroundSupervisionError(
      "background_postcondition_failed",
      `Chrome UI state changed during ${action}: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
      "Stop background work on this target and use the managed hidden provider or explicit foreground visibility.",
    );
  }
}

function registerListeners(): void {
  chrome.tabs.onCreated.addListener((tab) => {
    if (typeof tab.id !== "number" || typeof tab.windowId !== "number") return;
    const observation = observationFromTab(tab);
    unresolvedCreatedTabs.set(observation.tab_id, observation);
    if (initialized) rememberCreatedLineage(observation);
    enqueueLifecycleEvent({ type: "created", observation });
  });
  chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
    const observation: NavigationTargetObservation = {
      source_tab_id: details.sourceTabId,
      tab_id: details.tabId,
    };
    if (initialized) rememberNavigationLineage(observation);
    enqueueLifecycleEvent({ type: "navigation_target", observation });
  });
  chrome.tabs.onActivated.addListener((activeInfo) => {
    if (initialized) {
      const rootTabId = rootTabIdFor(activeInfo.tabId);
      if (rootTabId !== null && shouldSuperviseLifetime(rootTabId)) {
        markRootDirty(rootTabId);
      }
    }
    enqueueLifecycleEvent({
      type: "activated",
      tab_id: activeInfo.tabId,
      window_id: activeInfo.windowId,
    });
  });
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (initialized) markAllSupervisedRootsDirty();
    enqueueLifecycleEvent({ type: "focus_changed", window_id: windowId });
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    enqueueLifecycleEvent({
      type: "updated",
      tab_id: tabId,
      ...(changeInfo.status === undefined ? {} : { status: changeInfo.status }),
    });
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    const rootGuard = guards.get(tabId);
    const descendantRootTabId = descendants.get(tabId)?.root_tab_id;
    unresolvedCreatedTabs.delete(tabId);
    unresolvedUiCandidates.delete(tabId);
    knownTabIds.delete(tabId);
    enqueueLifecycleEvent({
      type: "removed",
      tab_id: tabId,
      ...(rootGuard ? { root_target_id: rootGuard.target_id } : {}),
      ...(descendantRootTabId === undefined
        ? {}
        : { descendant_root_tab_id: descendantRootTabId }),
    });
  });
}

function enqueueLifecycleEvent(event: BackgroundLifecycleEvent): void {
  lifecycleEvents.push(event);
  if (!initialized || lifecycleDrainScheduled) return;
  lifecycleDrainScheduled = true;
  queueMicrotask(() => {
    lifecycleDrainScheduled = false;
    if (initialized) schedule(drainLifecycleEventsLocked);
  });
}

async function ensureHydratedLocked(): Promise<void> {
  if (initialized) return;
  const [persistedGuards, persistedViolations, persistedLineages, tabs] =
    await Promise.all([
      readGuards(),
      readViolations(),
      readRetiredLineages(),
      chrome.tabs.query({}),
    ]);
  const unresolvedEventTabIds = new Set(
    lifecycleEvents
      .filter(
        (
          event,
        ): event is Extract<BackgroundLifecycleEvent, { type: "created" }> =>
          event.type === "created",
      )
      .map((event) => event.observation.tab_id),
  );
  guards.clear();
  violations.clear();
  retiredLineages.clear();
  retiredRootByTabId.clear();
  descendants.clear();
  unresolvedUiCandidates.clear();
  knownTabIds.clear();
  rootEpochs.clear();
  compensatedEpochs.clear();
  for (const tab of tabs) {
    if (
      typeof tab.id === "number" &&
      !unresolvedEventTabIds.has(tab.id) &&
      !unresolvedCreatedTabs.has(tab.id)
    ) {
      knownTabIds.add(tab.id);
    }
  }
  const tabsById = new Map(
    tabs
      .filter(
        (tab): tab is chrome.tabs.Tab & { id: number; windowId: number } =>
          typeof tab.id === "number" && typeof tab.windowId === "number",
      )
      .map((tab) => [tab.id, tab]),
  );
  for (const guard of persistedGuards) {
    guards.set(guard.tab_id, guard);
    knownTabIds.add(guard.tab_id);
    unresolvedCreatedTabs.delete(guard.tab_id);
    unresolvedUiCandidates.delete(guard.tab_id);
    rootEpochs.set(guard.tab_id, 0);
    compensatedEpochs.set(guard.tab_id, 0);
    for (const descendantTabId of guard.descendant_tab_ids) {
      const tab = tabsById.get(descendantTabId);
      if (!tab) continue;
      descendants.set(descendantTabId, {
        root_tab_id: guard.tab_id,
        observation: observationFromTab(tab),
      });
    }
  }
  for (const lineage of persistedLineages) {
    rememberRetiredLineage(lineage);
    for (const descendantTabId of lineage.lineage_tab_ids) {
      if (descendantTabId === lineage.root_tab_id) continue;
      const tab = tabsById.get(descendantTabId);
      if (!tab) continue;
      descendants.set(descendantTabId, {
        root_tab_id: lineage.root_tab_id,
        observation: observationFromTab(tab),
      });
    }
  }
  for (const violation of persistedViolations) {
    violations.set(violation.target_id, violation);
  }
  const lineagesPruned = pruneRetiredLineagesLocked();
  initialized = true;
  if (lineagesPruned) await persistRetiredLineagesLocked();
  await drainLifecycleEventsLocked();
}

async function drainLifecycleEventsLocked(): Promise<void> {
  while (lifecycleEvents.length > 0) {
    const events = lifecycleEvents.splice(0);
    const delayedEffects = new Map<number, string>();
    let guardsChanged = false;
    let retiredLineagesChanged = pruneRetiredLineagesLocked();
    let refreshRequested = false;

    for (const event of events) {
      switch (event.type) {
        case "created": {
          const rootTabId = rememberCreatedLineage(event.observation);
          if (rootTabId === null) {
            unresolvedCreatedTabs.set(
              event.observation.tab_id,
              event.observation,
            );
          } else {
            if (retiredLineages.has(rootTabId)) {
              retiredLineagesChanged = true;
            } else {
              guardsChanged = true;
            }
            delayedEffects.set(rootTabId, "created browser UI");
          }
          break;
        }
        case "navigation_target": {
          const rootTabId = rememberNavigationLineage(event.observation);
          if (rootTabId === null) break;
          const guard = guards.get(rootTabId);
          if (!guard && !activeRetiredLineage(rootTabId)) break;
          let observation = descendants.get(
            event.observation.tab_id,
          )?.observation;
          if (!observation) {
            try {
              observation = observationFromTab(
                await chrome.tabs.get(event.observation.tab_id),
              );
            } catch (error) {
              if (!isMissingTabError(error)) throw error;
              removeDescendantMemory(event.observation.tab_id, rootTabId);
              guardsChanged = true;
              break;
            }
          }
          descendants.set(event.observation.tab_id, {
            root_tab_id: rootTabId,
            observation,
          });
          unresolvedCreatedTabs.delete(event.observation.tab_id);
          unresolvedUiCandidates.delete(event.observation.tab_id);
          if (retiredLineages.has(rootTabId)) {
            retiredLineagesChanged = true;
          } else {
            guardsChanged = true;
          }
          delayedEffects.set(rootTabId, "created a navigation target");
          break;
        }
        case "activated": {
          const rootTabId = rootTabIdFor(event.tab_id);
          if (rootTabId !== null && shouldSuperviseLifetime(rootTabId)) {
            markRootDirty(rootTabId);
            delayedEffects.set(rootTabId, "became active");
          } else if (unresolvedCreatedTabs.has(event.tab_id)) {
            await rememberUnresolvedUiCandidateLocked(
              event.tab_id,
              event.window_id,
              false,
            );
          } else if (knownTabIds.has(event.tab_id)) {
            const changed = rememberKnownUserActivationLocked(
              event.tab_id,
              event.window_id,
            );
            guardsChanged ||= changed.guards;
            retiredLineagesChanged ||= changed.retiredLineages;
            refreshRequested = true;
          }
          break;
        }
        case "focus_changed": {
          const changed = rememberKnownUserFocusLocked(event.window_id);
          guardsChanged ||= changed.guards;
          retiredLineagesChanged ||= changed.retiredLineages;
          const state = await captureChromeUiState();
          const focusedActiveTabId = state.active_tabs.find(
            (active) => active.window_id === event.window_id,
          )?.tab_id;
          const rootTabId =
            focusedActiveTabId === undefined
              ? null
              : rootTabIdFor(focusedActiveTabId);
          if (rootTabId !== null && shouldSuperviseLifetime(rootTabId)) {
            markRootDirty(rootTabId);
            delayedEffects.set(rootTabId, "changed window focus");
          } else if (
            focusedActiveTabId !== undefined &&
            unresolvedCreatedTabs.has(focusedActiveTabId)
          ) {
            await rememberUnresolvedUiCandidateLocked(
              focusedActiveTabId,
              event.window_id,
              true,
            );
          } else if (
            focusedActiveTabId !== undefined &&
            knownTabIds.has(focusedActiveTabId)
          ) {
            refreshRequested = true;
          }
          break;
        }
        case "updated": {
          if (
            event.status === "complete" &&
            unresolvedCreatedTabs.has(event.tab_id) &&
            !descendants.has(event.tab_id)
          ) {
            const candidate = unresolvedUiCandidates.get(event.tab_id);
            unresolvedCreatedTabs.delete(event.tab_id);
            unresolvedUiCandidates.delete(event.tab_id);
            knownTabIds.add(event.tab_id);
            if (candidate) {
              await refreshSafeStateLocked(candidate.state);
            } else {
              refreshRequested = true;
            }
          }
          break;
        }
        case "removed": {
          const rootGuard = guards.get(event.tab_id);
          const rootTargetId = event.root_target_id ?? rootGuard?.target_id;
          if (rootTargetId !== undefined) {
            await forgetBackgroundTargetSupervisionLocked(
              rootTargetId,
              event.tab_id,
            );
            retiredLineagesChanged = true;
          } else if (event.descendant_root_tab_id !== undefined) {
            removeDescendantMemory(event.tab_id, event.descendant_root_tab_id);
            if (retiredLineages.has(event.descendant_root_tab_id)) {
              retiredLineagesChanged = true;
            } else {
              guardsChanged = true;
            }
          }
          break;
        }
      }
    }

    if (guardsChanged) await persistGuardsLocked();
    if (retiredLineagesChanged) await persistRetiredLineagesLocked();
    for (const [rootTabId, effect] of delayedEffects) {
      if (commandScopedRoots.has(rootTabId)) continue;
      if (activeRetiredLineage(rootTabId)) {
        await compensateRetiredLineageLocked(rootTabId, effect);
        continue;
      }
      if (
        (rootEpochs.get(rootTabId) ?? 0) <=
        (compensatedEpochs.get(rootTabId) ?? 0)
      ) {
        continue;
      }
      await pruneMissingDescendantsLocked(rootTabId);
      const guard = guards.get(rootTabId);
      if (
        guard &&
        createdTabsForRoot(rootTabId).size === 0 &&
        !controlledUiIsActive(guard, await captureChromeUiState())
      ) {
        compensatedEpochs.set(rootTabId, rootEpochs.get(rootTabId) ?? 0);
        continue;
      }
      await compensateDelayedUiLocked(rootTabId, effect);
    }
    if (refreshRequested) await refreshSafeStateLocked();
  }
}

async function pruneMissingDescendantsLocked(rootTabId: number): Promise<void> {
  const guard = guards.get(rootTabId);
  if (!guard) return;
  let changed = false;
  for (const tabId of guard.descendant_tab_ids.slice()) {
    try {
      const observation = observationFromTab(await chrome.tabs.get(tabId));
      descendants.set(tabId, { root_tab_id: rootTabId, observation });
    } catch (error) {
      if (!isMissingTabError(error)) throw error;
      removeDescendantMemory(tabId, rootTabId);
      changed = true;
    }
  }
  if (changed) await persistGuardsLocked();
}

function rememberCreatedLineage(
  observation: CreatedTabObservation,
): number | null {
  const existing = descendants.get(observation.tab_id);
  const rootTabId =
    existing?.root_tab_id ??
    (observation.opener_tab_id === null
      ? null
      : rootTabIdFor(observation.opener_tab_id));
  if (rootTabId === null || !shouldSuperviseLifetime(rootTabId)) return null;
  rememberDescendant(rootTabId, observation.tab_id, observation);
  return rootTabId;
}

function rememberNavigationLineage(
  observation: NavigationTargetObservation,
): number | null {
  const rootTabId = rootTabIdFor(observation.source_tab_id);
  if (rootTabId === null || !shouldSuperviseLifetime(rootTabId)) return null;
  rememberDescendant(
    rootTabId,
    observation.tab_id,
    unresolvedCreatedTabs.get(observation.tab_id),
  );
  return rootTabId;
}

function rememberDescendant(
  rootTabId: number,
  tabId: number,
  observation?: CreatedTabObservation,
): void {
  const guard = guards.get(rootTabId);
  const retiredLineage = activeRetiredLineage(rootTabId);
  if (!guard && !retiredLineage) return;
  const previous = descendants.get(tabId);
  descendants.set(tabId, {
    root_tab_id: rootTabId,
    ...((observation ?? previous?.observation)
      ? { observation: observation ?? previous?.observation }
      : {}),
  });
  if (guard && !guard.descendant_tab_ids.includes(tabId)) {
    guard.descendant_tab_ids.push(tabId);
    guard.descendant_tab_ids.sort((left, right) => left - right);
  }
  if (retiredLineage) rememberRetiredLineageTab(retiredLineage, tabId);
  unresolvedCreatedTabs.delete(tabId);
  unresolvedUiCandidates.delete(tabId);
  markRootDirty(rootTabId);
}

function removeDescendantMemory(tabId: number, rootTabId: number): void {
  descendants.delete(tabId);
  const guard = guards.get(rootTabId);
  if (guard) {
    guard.descendant_tab_ids = guard.descendant_tab_ids.filter(
      (candidate) => candidate !== tabId,
    );
  }
}

function removeGuardMemory(tabId: number, preserveLineage = false): void {
  guards.delete(tabId);
  unresolvedUiCandidates.delete(tabId);
  commandScopedRoots.delete(tabId);
  rootEpochs.delete(tabId);
  compensatedEpochs.delete(tabId);
  if (!preserveLineage) {
    for (const [descendantTabId, descendant] of descendants) {
      if (descendant.root_tab_id === tabId) descendants.delete(descendantTabId);
    }
  }
}

async function rememberUnresolvedUiCandidateLocked(
  tabId: number,
  windowId: number,
  focused: boolean,
): Promise<void> {
  try {
    const existingCandidate = unresolvedUiCandidates.get(tabId);
    const [tab, observedState, liveTabs] = await Promise.all([
      chrome.tabs.get(tabId),
      captureChromeUiState(),
      chrome.tabs.query({}),
    ]);
    if (typeof tab.id !== "number" || typeof tab.windowId !== "number") return;
    const baseline = guards.values().next().value?.safe_state as
      | ChromeUiState
      | undefined;
    const controlledTabIds = new Set<number>();
    for (const guard of guards.values()) {
      controlledTabIds.add(guard.tab_id);
      for (const descendantTabId of guard.descendant_tab_ids) {
        controlledTabIds.add(descendantTabId);
      }
    }
    const state = structuredClone(observedState);
    const tabsByWindow = new Map<number, number[]>();
    for (const liveTab of liveTabs) {
      if (
        typeof liveTab.id !== "number" ||
        typeof liveTab.windowId !== "number"
      ) {
        continue;
      }
      const windowTabs = tabsByWindow.get(liveTab.windowId) ?? [];
      windowTabs.push(liveTab.id);
      tabsByWindow.set(liveTab.windowId, windowTabs);
    }
    const attributableWindowIds = new Set<number>();
    for (const candidateWindowId of state.window_ids) {
      if (
        candidateWindowId === windowId ||
        baseline?.window_ids.includes(candidateWindowId)
      ) {
        continue;
      }
      const windowTabs = tabsByWindow.get(candidateWindowId) ?? [];
      if (
        windowTabs.length > 0 &&
        windowTabs.every(
          (candidateTabId) =>
            controlledTabIds.has(candidateTabId) ||
            (candidateTabId !== tabId &&
              unresolvedCreatedTabs.has(candidateTabId)),
        )
      ) {
        attributableWindowIds.add(candidateWindowId);
      }
    }
    state.window_ids = state.window_ids.filter(
      (candidateWindowId) => !attributableWindowIds.has(candidateWindowId),
    );
    const activeByWindow = new Map(
      state.active_tabs
        .filter((active) => !attributableWindowIds.has(active.window_id))
        .map((active) => [active.window_id, active.tab_id]),
    );
    for (const active of state.active_tabs) {
      if (
        active.tab_id !== tabId &&
        (controlledTabIds.has(active.tab_id) ||
          unresolvedCreatedTabs.has(active.tab_id))
      ) {
        const baselineActive = baseline?.active_tabs.find(
          (candidate) => candidate.window_id === active.window_id,
        );
        if (baselineActive) {
          activeByWindow.set(active.window_id, baselineActive.tab_id);
        } else {
          activeByWindow.delete(active.window_id);
        }
      }
    }
    activeByWindow.set(windowId, tabId);
    state.active_tabs = [...activeByWindow]
      .map(([candidateWindowId, candidateTabId]) => ({
        window_id: candidateWindowId,
        tab_id: candidateTabId,
      }))
      .sort(
        (left, right) =>
          left.window_id - right.window_id || left.tab_id - right.tab_id,
      );
    if (!state.window_ids.includes(windowId)) {
      state.window_ids.push(windowId);
      state.window_ids.sort((left, right) => left - right);
    }
    if (focused || existingCandidate?.state.focused_window_id === windowId) {
      state.focused_window_id = windowId;
    } else if (
      state.focused_window_id !== null &&
      !activeByWindow.has(state.focused_window_id)
    ) {
      state.focused_window_id = baseline?.focused_window_id ?? null;
    }
    unresolvedUiCandidates.set(tabId, {
      revision: ++unresolvedUiRevision,
      state,
    });
  } catch (error) {
    if (!isMissingTabError(error)) throw error;
    unresolvedCreatedTabs.delete(tabId);
    unresolvedUiCandidates.delete(tabId);
  }
}

async function recoveryStateForRootLocked(
  rootTabId: number,
  fallback: ChromeUiState,
): Promise<ChromeUiState> {
  const candidates = [...unresolvedUiCandidates.entries()].sort(
    (left, right) => right[1].revision - left[1].revision,
  );
  for (const [tabId, candidate] of candidates) {
    if (
      !unresolvedCreatedTabs.has(tabId) ||
      descendants.get(tabId)?.root_tab_id === rootTabId
    ) {
      unresolvedUiCandidates.delete(tabId);
      continue;
    }
    try {
      await chrome.tabs.get(tabId);
      return structuredClone(candidate.state);
    } catch (error) {
      if (!isMissingTabError(error)) throw error;
      unresolvedCreatedTabs.delete(tabId);
      unresolvedUiCandidates.delete(tabId);
    }
  }
  return structuredClone(fallback);
}

function markRootDirty(rootTabId: number): void {
  rootEpochs.set(rootTabId, (rootEpochs.get(rootTabId) ?? 0) + 1);
}

function markAllSupervisedRootsDirty(): void {
  for (const guard of guards.values()) {
    if (guard.owned && guard.page_mutated) markRootDirty(guard.tab_id);
  }
}

async function compensateDelayedUiLocked(
  rootTabId: number,
  effect: string,
): Promise<void> {
  const guard = guards.get(rootTabId);
  if (!guard?.owned || !guard.page_mutated) return;
  let message = `Chrome background target ${guard.target_id} ${effect} after its command boundary; Uni-CLI compensated the attributable change`;
  let shouldPoisonTarget = false;
  try {
    const result = await compensateUntilStableLocked(
      guard.safe_state,
      rootTabId,
      "delayed page effect",
    );
    shouldPoisonTarget = result.attributable_ui_changed;
  } catch (error) {
    shouldPoisonTarget = true;
    message = `${message}; compensation was incomplete: ${errorMessage(error)}`;
  }
  if (!shouldPoisonTarget) return;
  await recordViolationLocked({
    target_id: guard.target_id,
    tab_id: guard.tab_id,
    message,
    occurred_at: new Date().toISOString(),
  });
}

async function compensateRetiredLineageLocked(
  rootTabId: number,
  effect: string,
): Promise<void> {
  const lineage = activeRetiredLineage(rootTabId);
  if (!lineage) return;
  const recoveryState = await recoveryStateForRootLocked(
    rootTabId,
    lineage.safe_state,
  );
  await compensateBackgroundPageCommand(
    recoveryState,
    rootTabId,
    `retired target ${effect}`,
    createdTabsForRoot(rootTabId),
  );
  compensatedEpochs.set(rootTabId, rootEpochs.get(rootTabId) ?? 0);
}

async function refreshSafeStateLocked(
  suppliedState?: ChromeUiState,
): Promise<void> {
  if (guards.size === 0 && retiredLineages.size === 0) return;
  const state = suppliedState
    ? structuredClone(suppliedState)
    : await captureChromeUiState();
  const activeTabIds = new Set(
    state.active_tabs.map((active) => active.tab_id),
  );
  if (
    [...unresolvedCreatedTabs.keys()].some((tabId) => activeTabIds.has(tabId))
  ) {
    return;
  }
  const focusedActiveTabId = state.active_tabs.find(
    (active) => active.window_id === state.focused_window_id,
  )?.tab_id;
  const focusedRoot =
    focusedActiveTabId === undefined ? null : rootTabIdFor(focusedActiveTabId);
  if (focusedRoot !== null && shouldSuperviseLifetime(focusedRoot)) return;
  for (const guard of guards.values()) {
    if (commandScopedRoots.has(guard.tab_id)) continue;
    guard.safe_state = structuredClone(state);
  }
  for (const lineage of retiredLineages.values()) {
    lineage.safe_state = structuredClone(state);
  }
  await persistGuardsLocked();
  await persistRetiredLineagesLocked();
}

function rememberKnownUserActivationLocked(
  tabId: number,
  windowId: number,
): { guards: boolean; retiredLineages: boolean } {
  let guardsChanged = false;
  for (const guard of guards.values()) {
    if (commandScopedRoots.has(guard.tab_id)) continue;
    rememberSafeStateActivation(guard.safe_state, tabId, windowId);
    guardsChanged = true;
  }
  let retiredLineagesChanged = false;
  for (const lineage of retiredLineages.values()) {
    rememberSafeStateActivation(lineage.safe_state, tabId, windowId);
    retiredLineagesChanged = true;
  }
  return { guards: guardsChanged, retiredLineages: retiredLineagesChanged };
}

function rememberKnownUserFocusLocked(windowId: number): {
  guards: boolean;
  retiredLineages: boolean;
} {
  let guardsChanged = false;
  for (const guard of guards.values()) {
    if (commandScopedRoots.has(guard.tab_id)) continue;
    const activeTabId = guard.safe_state.active_tabs.find(
      (active) => active.window_id === windowId,
    )?.tab_id;
    if (activeTabId === undefined || !knownTabIds.has(activeTabId)) continue;
    guard.safe_state.focused_window_id = windowId;
    guardsChanged = true;
  }
  let retiredLineagesChanged = false;
  for (const lineage of retiredLineages.values()) {
    const activeTabId = lineage.safe_state.active_tabs.find(
      (active) => active.window_id === windowId,
    )?.tab_id;
    if (activeTabId === undefined || !knownTabIds.has(activeTabId)) continue;
    lineage.safe_state.focused_window_id = windowId;
    retiredLineagesChanged = true;
  }
  return { guards: guardsChanged, retiredLineages: retiredLineagesChanged };
}

function rememberSafeStateActivation(
  state: ChromeUiState,
  tabId: number,
  windowId: number,
): void {
  if (!state.window_ids.includes(windowId)) {
    state.window_ids.push(windowId);
    state.window_ids.sort((left, right) => left - right);
  }
  state.active_tabs = state.active_tabs
    .filter(
      (active) => active.window_id !== windowId && active.tab_id !== tabId,
    )
    .concat({ window_id: windowId, tab_id: tabId })
    .sort(
      (left, right) =>
        left.window_id - right.window_id || left.tab_id - right.tab_id,
    );
}

async function compensateUntilStableLocked(
  before: ChromeUiState,
  targetTabId: number,
  action: string,
  additionalCreatedTabs: ReadonlyMap<number, CreatedTabObservation> = new Map(),
  signal?: AbortSignal,
): Promise<BackgroundCompensationResult> {
  const attributableTabIds = new Set<number>();
  let attributableUiChanged = false;
  let deferredCompensationError: unknown;
  const startedAt = Date.now();
  let iteration = 0;
  for (;;) {
    if (
      signal?.aborted === true ||
      iteration >= MAX_COMPENSATION_ITERATIONS ||
      Date.now() - startedAt >= MAX_COMPENSATION_MS
    ) {
      const reason = signal?.aborted
        ? "the caller cancelled before recovery reached a stable lifecycle boundary"
        : "attributable Chrome UI effects did not quiesce within the recovery budget";
      const recoveryState = await recoveryStateForRootLocked(
        targetTabId,
        before,
      );
      let containmentError: unknown;
      try {
        await containAndRetireRootLocked(
          recoveryState,
          targetTabId,
          action,
          additionalCreatedTabs,
        );
      } catch (error) {
        containmentError = error;
      }
      throw new BackgroundSupervisionError(
        "background_supervisor_budget_exceeded",
        `Chrome background ${action} was stopped because ${reason}`,
        "Continue on a fresh background target; the non-quiescent target has been retired.",
        {
          ...(containmentError === undefined
            ? {}
            : { cause: containmentError }),
          outcomeAmbiguous: true,
          targetUnusable: true,
        },
      );
    }
    iteration += 1;
    const observedEpoch = rootEpochs.get(targetTabId) ?? 0;
    const createdTabs = new Map(additionalCreatedTabs);
    for (const [tabId, observation] of createdTabsForRoot(targetTabId)) {
      createdTabs.set(tabId, observation);
    }
    try {
      const recoveryState = await recoveryStateForRootLocked(
        targetTabId,
        before,
      );
      const result = await compensateBackgroundPageCommand(
        recoveryState,
        targetTabId,
        action,
        createdTabs,
      );
      attributableUiChanged ||= result.attributable_ui_changed;
    } catch (error) {
      deferredCompensationError ??= error;
      attributableUiChanged = true;
    }
    for (const tabId of findAttributableCreatedTabs(
      targetTabId,
      createdTabs,
    ).map((tab) => tab.tab_id)) {
      attributableTabIds.add(tabId);
    }
    if ((rootEpochs.get(targetTabId) ?? 0) !== observedEpoch) continue;
    compensatedEpochs.set(targetTabId, observedEpoch);
    if (deferredCompensationError !== undefined) {
      throw deferredCompensationError;
    }
    return {
      attributable_tab_count: attributableTabIds.size,
      attributable_ui_changed: attributableUiChanged,
    };
  }
}

async function containAndRetireRootLocked(
  recoveryState: ChromeUiState,
  targetTabId: number,
  action: string,
  additionalCreatedTabs: ReadonlyMap<number, CreatedTabObservation>,
): Promise<void> {
  const guard = guards.get(targetTabId);
  const errors: unknown[] = [];
  let rootRemoved = false;
  try {
    await chrome.tabs.remove(targetTabId);
    rootRemoved = true;
  } catch (error) {
    if (isMissingTabError(error)) {
      rootRemoved = true;
    } else {
      errors.push(error);
    }
  }

  for (let iteration = 0; iteration < MAX_CONTAINMENT_ITERATIONS; iteration++) {
    const observedEpoch = rootEpochs.get(targetTabId) ?? 0;
    const createdTabs = new Map(additionalCreatedTabs);
    for (const [tabId, observation] of createdTabsForRoot(targetTabId)) {
      createdTabs.set(tabId, observation);
    }
    try {
      await compensateBackgroundPageCommand(
        recoveryState,
        targetTabId,
        `${action} containment`,
        createdTabs,
      );
    } catch (error) {
      errors.push(error);
    }
    if ((rootEpochs.get(targetTabId) ?? 0) === observedEpoch) break;
  }

  if (rootRemoved && guard) {
    try {
      await forgetChromeTarget(guard.target_id);
      await forgetBackgroundTargetSupervisionLocked(
        guard.target_id,
        targetTabId,
      );
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw errors.length === 1
      ? errors[0]
      : new AggregateError(
          errors,
          `Chrome background ${action} containment was incomplete`,
        );
  }
}

async function compensateBackgroundPageCommand(
  before: ChromeUiState,
  targetTabId: number,
  action: string,
  createdTabs: ReadonlyMap<number, CreatedTabObservation>,
): Promise<BackgroundCompensationResult> {
  const attributableTabs = findAttributableCreatedTabs(
    targetTabId,
    createdTabs,
  );
  const attributableTabIds = new Set(attributableTabs.map((tab) => tab.tab_id));
  const effectTabIds = new Set([targetTabId, ...attributableTabIds]);
  const errors: unknown[] = [];
  let afterCommand: ChromeUiState | null = null;
  try {
    afterCommand = await captureChromeUiState();
  } catch (error) {
    errors.push(error);
  }

  const fullyAttributableWindowIds = new Set<number>();
  for (const windowId of new Set(
    attributableTabs.map((tab) => tab.window_id),
  )) {
    if (before.window_ids.includes(windowId)) continue;
    try {
      const windowTabs = await chrome.tabs.query({ windowId });
      if (
        windowTabs.length > 0 &&
        windowTabs.every(
          (tab) => typeof tab.id === "number" && attributableTabIds.has(tab.id),
        )
      ) {
        fullyAttributableWindowIds.add(windowId);
      }
    } catch (error) {
      errors.push(error);
    }
  }

  const activeUiChanged =
    afterCommand?.active_tabs.some((active) => {
      const activeBefore = before.active_tabs.find(
        (candidate) => candidate.window_id === active.window_id,
      );
      return (
        activeBefore?.tab_id !== active.tab_id &&
        effectTabIds.has(active.tab_id)
      );
    }) ?? false;
  const focusedAfterCommand = afterCommand?.focused_window_id ?? null;
  const focusedActiveAfterCommand = afterCommand?.active_tabs.find(
    (active) => active.window_id === focusedAfterCommand,
  );
  const focusUiChanged =
    focusedAfterCommand !== before.focused_window_id &&
    focusedAfterCommand !== null &&
    (fullyAttributableWindowIds.has(focusedAfterCommand) ||
      (focusedActiveAfterCommand !== undefined &&
        effectTabIds.has(focusedActiveAfterCommand.tab_id)));

  if (focusUiChanged && before.focused_window_id !== null) {
    try {
      const current = await captureChromeUiState();
      const activeInFocusedWindow = current.active_tabs.find(
        (active) => active.window_id === current.focused_window_id,
      );
      if (
        current.focused_window_id === focusedAfterCommand &&
        (fullyAttributableWindowIds.has(focusedAfterCommand) ||
          (activeInFocusedWindow !== undefined &&
            effectTabIds.has(activeInFocusedWindow.tab_id)))
      ) {
        await chrome.windows.update(before.focused_window_id, {
          focused: true,
        });
      }
    } catch (error) {
      errors.push(error);
    }
  }

  for (const tab of attributableTabs) {
    try {
      await chrome.tabs.remove(tab.tab_id);
    } catch (error) {
      if (!isMissingTabError(error)) errors.push(error);
    }
  }

  let afterCleanup: ChromeUiState | null = null;
  try {
    afterCleanup = await captureChromeUiState();
  } catch (error) {
    errors.push(error);
  }
  if (afterCommand && afterCleanup) {
    for (const activeBefore of before.active_tabs) {
      const activeAfterCommand = afterCommand.active_tabs.find(
        (active) => active.window_id === activeBefore.window_id,
      );
      const activeAfterCleanup = afterCleanup.active_tabs.find(
        (active) => active.window_id === activeBefore.window_id,
      );
      if (
        activeAfterCommand &&
        effectTabIds.has(activeAfterCommand.tab_id) &&
        (activeAfterCleanup === undefined ||
          effectTabIds.has(activeAfterCleanup.tab_id)) &&
        activeAfterCleanup?.tab_id !== activeBefore.tab_id
      ) {
        try {
          await chrome.tabs.update(activeBefore.tab_id, { active: true });
        } catch (error) {
          errors.push(error);
        }
      }
    }

    const activeInFocusedWindow = afterCleanup.active_tabs.find(
      (active) => active.window_id === afterCleanup.focused_window_id,
    );
    const focusStillAttributable =
      afterCleanup.focused_window_id === focusedAfterCommand &&
      (activeInFocusedWindow === undefined ||
        effectTabIds.has(activeInFocusedWindow.tab_id));
    const attributableWindowClosedWithoutReplacement =
      fullyAttributableWindowIds.has(focusedAfterCommand ?? -1) &&
      afterCleanup.focused_window_id === null;
    if (
      focusUiChanged &&
      before.focused_window_id !== null &&
      afterCleanup.focused_window_id !== before.focused_window_id &&
      (focusStillAttributable || attributableWindowClosedWithoutReplacement)
    ) {
      try {
        await chrome.windows.update(before.focused_window_id, {
          focused: true,
        });
      } catch (error) {
        errors.push(error);
      }
    }
  }

  try {
    await assertChromeUiStateUnchanged(before, action);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new BackgroundSupervisionError(
      "background_postcondition_failed",
      `Chrome background ${action} compensation was incomplete: ${errors.map(errorMessage).join("; ")}`,
      "Stop work on this target and inspect Chrome UI state before issuing another mutation.",
      {
        cause:
          errors.length === 1
            ? errors[0]
            : new AggregateError(errors, "Background compensation failed"),
        outcomeAmbiguous: true,
        targetUnusable: true,
      },
    );
  }
  return {
    attributable_tab_count: attributableTabs.length,
    attributable_ui_changed:
      attributableTabs.length > 0 || activeUiChanged || focusUiChanged,
  };
}

function findAttributableCreatedTabs(
  targetTabId: number,
  createdTabs: ReadonlyMap<number, CreatedTabObservation>,
): CreatedTabObservation[] {
  const depths = new Map<number, number>([[targetTabId, 0]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const tab of createdTabs.values()) {
      if (depths.has(tab.tab_id)) continue;
      if (tab.opener_tab_id === null) {
        const lineage = descendants.get(tab.tab_id);
        if (lineage?.root_tab_id !== targetTabId) continue;
        depths.set(tab.tab_id, 1);
        changed = true;
        continue;
      }
      const openerDepth = depths.get(tab.opener_tab_id);
      if (openerDepth === undefined) continue;
      depths.set(tab.tab_id, openerDepth + 1);
      changed = true;
    }
  }
  return [...createdTabs.values()]
    .filter((tab) => depths.has(tab.tab_id))
    .sort(
      (left, right) =>
        (depths.get(right.tab_id) ?? 0) - (depths.get(left.tab_id) ?? 0) ||
        right.tab_id - left.tab_id,
    );
}

function createdTabsForRoot(
  rootTabId: number,
): Map<number, CreatedTabObservation> {
  const created = new Map<number, CreatedTabObservation>();
  for (const [tabId, descendant] of descendants) {
    if (descendant.root_tab_id === rootTabId && descendant.observation) {
      created.set(tabId, descendant.observation);
    }
  }
  return created;
}

function controlledUiIsActive(
  guard: BackgroundTargetGuard,
  state: ChromeUiState,
): boolean {
  const effectTabs = new Set([guard.tab_id, ...guard.descendant_tab_ids]);
  return state.active_tabs.some((active) => effectTabs.has(active.tab_id));
}

async function retireUnrecoverableTargetLocked(
  target: ChromeNativeTarget,
): Promise<void> {
  if (target.owned) {
    try {
      await chrome.tabs.remove(target.tab_id);
    } catch (error) {
      if (!isMissingTabError(error)) throw error;
    }
  }
  await forgetChromeTarget(target.target_id);
  await forgetBackgroundTargetSupervisionLocked(
    target.target_id,
    target.tab_id,
  );
}

function requireGuardLocked(
  targetId: string,
  tabId: number,
): BackgroundTargetGuard {
  const guard = guards.get(tabId);
  if (!guard || guard.target_id !== targetId) {
    throw new BackgroundSupervisionError(
      "background_target_unsupervised",
      `Chrome background target ${targetId} has no durable ownership guard`,
      "Allocate or claim the target again so Uni-CLI can establish its ownership and safe UI baseline.",
      { targetUnusable: true },
    );
  }
  return guard;
}

async function forgetBackgroundTargetSupervisionLocked(
  targetId: string,
  tabId: number,
): Promise<void> {
  const guard = guards.get(tabId);
  if (guard?.target_id === targetId) rememberRetiredLineageFromGuard(guard);
  removeGuardMemory(tabId, retiredLineages.has(tabId));
  violations.delete(targetId);
  await persistGuardsLocked();
  await persistViolationsLocked();
  await persistRetiredLineagesLocked();
}

function rootTabIdFor(tabId: number): number | null {
  if (guards.has(tabId)) return tabId;
  const descendantRoot = descendants.get(tabId)?.root_tab_id;
  if (descendantRoot !== undefined) return descendantRoot;
  const retiredRoot = retiredRootByTabId.get(tabId);
  return retiredRoot !== undefined && activeRetiredLineage(retiredRoot)
    ? retiredRoot
    : null;
}

function shouldSuperviseLifetime(rootTabId: number): boolean {
  const guard = guards.get(rootTabId);
  return (
    (guard?.owned === true && guard.page_mutated) ||
    activeRetiredLineage(rootTabId) !== undefined
  );
}

function rememberRetiredLineageFromGuard(guard: BackgroundTargetGuard): void {
  if (!guard.owned || !guard.page_mutated) return;
  const existing = activeRetiredLineage(guard.tab_id);
  const lineageTabIds = new Set<number>([
    guard.tab_id,
    ...guard.descendant_tab_ids,
    ...(existing?.lineage_tab_ids ?? []),
  ]);
  for (const [tabId, descendant] of descendants) {
    if (descendant.root_tab_id === guard.tab_id) lineageTabIds.add(tabId);
  }
  rememberRetiredLineage({
    root_tab_id: guard.tab_id,
    safe_state: structuredClone(guard.safe_state),
    lineage_tab_ids: [...lineageTabIds].sort((left, right) => left - right),
    expires_at: Date.now() + RETIRED_BACKGROUND_LINEAGE_TTL_MS,
  });
}

function rememberRetiredLineage(lineage: RetiredBackgroundLineage): void {
  pruneRetiredLineagesLocked();
  if (
    !retiredLineages.has(lineage.root_tab_id) &&
    retiredLineages.size >= MAX_RETIRED_BACKGROUND_LINEAGES
  ) {
    const oldest = [...retiredLineages.values()].sort(
      (left, right) =>
        left.expires_at - right.expires_at ||
        left.root_tab_id - right.root_tab_id,
    )[0];
    if (oldest) removeRetiredLineageMemory(oldest.root_tab_id);
    supervisorFailure ??= new BackgroundSupervisionError(
      "background_lineage_capacity_exceeded",
      `Chrome retired-root supervision exceeded ${String(MAX_RETIRED_BACKGROUND_LINEAGES)} concurrent lineages`,
      "Wait for the bounded retired-lineage horizon to expire before starting more background mutations.",
      { targetUnusable: true },
    );
  }
  const previous = retiredLineages.get(lineage.root_tab_id);
  if (previous) removeRetiredLineageMemory(previous.root_tab_id);
  const stored = structuredClone(lineage);
  retiredLineages.set(stored.root_tab_id, stored);
  for (const tabId of stored.lineage_tab_ids) {
    const existingRoot = retiredRootByTabId.get(tabId);
    if (existingRoot !== undefined && existingRoot !== stored.root_tab_id) {
      supervisorFailure ??= new BackgroundSupervisionError(
        "background_lineage_ambiguous",
        `Chrome tab ${String(tabId)} belongs to conflicting retired roots ${String(existingRoot)} and ${String(stored.root_tab_id)}`,
        "Restart Chrome to establish a fresh browser session before continuing background mutations.",
        { targetUnusable: true },
      );
      continue;
    }
    retiredRootByTabId.set(tabId, stored.root_tab_id);
  }
}

function rememberRetiredLineageTab(
  lineage: RetiredBackgroundLineage,
  tabId: number,
): void {
  if (lineage.lineage_tab_ids.includes(tabId)) return;
  if (lineage.lineage_tab_ids.length >= MAX_RETIRED_LINEAGE_TAB_IDS) {
    supervisorFailure ??= new BackgroundSupervisionError(
      "background_lineage_capacity_exceeded",
      `Chrome retired root ${String(lineage.root_tab_id)} exceeded ${String(MAX_RETIRED_LINEAGE_TAB_IDS)} attributable descendants`,
      "Restart Chrome to terminate the non-quiescent page lineage before continuing background mutations.",
      { targetUnusable: true },
    );
    return;
  }
  lineage.lineage_tab_ids.push(tabId);
  lineage.lineage_tab_ids.sort((left, right) => left - right);
  retiredRootByTabId.set(tabId, lineage.root_tab_id);
}

function activeRetiredLineage(
  rootTabId: number,
  now = Date.now(),
): RetiredBackgroundLineage | undefined {
  const lineage = retiredLineages.get(rootTabId);
  return lineage && lineage.expires_at > now ? lineage : undefined;
}

function pruneRetiredLineagesLocked(now = Date.now()): boolean {
  let changed = false;
  for (const lineage of retiredLineages.values()) {
    if (lineage.expires_at > now) continue;
    removeRetiredLineageMemory(lineage.root_tab_id);
    changed = true;
  }
  return changed;
}

function removeRetiredLineageMemory(rootTabId: number): void {
  const lineage = retiredLineages.get(rootTabId);
  if (!lineage) return;
  retiredLineages.delete(rootTabId);
  for (const tabId of lineage.lineage_tab_ids) {
    if (retiredRootByTabId.get(tabId) === rootTabId) {
      retiredRootByTabId.delete(tabId);
    }
  }
  for (const [tabId, descendant] of descendants) {
    if (descendant.root_tab_id === rootTabId) descendants.delete(tabId);
  }
  rootEpochs.delete(rootTabId);
  compensatedEpochs.delete(rootTabId);
}

function observationFromTab(tab: chrome.tabs.Tab): CreatedTabObservation {
  if (typeof tab.id !== "number" || typeof tab.windowId !== "number") {
    throw new Error("Chrome tab has no stable id or window id");
  }
  return {
    tab_id: tab.id,
    window_id: tab.windowId,
    opener_tab_id: typeof tab.openerTabId === "number" ? tab.openerTabId : null,
  };
}

function schedule(operation: () => Promise<void>): void {
  void serialize(operation).catch((error: unknown) => {
    supervisorFailure = error;
    console.error(
      `[unicli] Background UI supervision failed: ${errorMessage(error)}`,
    );
  });
}

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const run = supervisionTail.then(operation, operation);
  supervisionTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function recordViolationLocked(
  violation: BackgroundUiViolation,
): Promise<void> {
  violations.set(violation.target_id, violation);
  await persistViolationsLocked();
}

async function readGuards(): Promise<BackgroundTargetGuard[]> {
  const stored = await chrome.storage.session.get(BACKGROUND_GUARDS_KEY);
  const value = stored[BACKGROUND_GUARDS_KEY];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isBackgroundTargetGuard)) {
    throw new Error("Chrome background guard ledger is malformed");
  }
  return structuredClone(value);
}

async function persistGuardsLocked(): Promise<void> {
  await chrome.storage.session.set({
    [BACKGROUND_GUARDS_KEY]: [...guards.values()]
      .map((guard) => structuredClone(guard))
      .sort((left, right) => left.tab_id - right.tab_id),
  });
}

async function readRetiredLineages(): Promise<RetiredBackgroundLineage[]> {
  const stored = await chrome.storage.session.get(
    RETIRED_BACKGROUND_LINEAGES_KEY,
  );
  const value = stored[RETIRED_BACKGROUND_LINEAGES_KEY];
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > MAX_RETIRED_BACKGROUND_LINEAGES ||
    !value.every(isRetiredBackgroundLineage)
  ) {
    throw new Error("Chrome retired background lineage ledger is malformed");
  }
  return structuredClone(value);
}

async function persistRetiredLineagesLocked(): Promise<void> {
  pruneRetiredLineagesLocked();
  await chrome.storage.session.set({
    [RETIRED_BACKGROUND_LINEAGES_KEY]: [...retiredLineages.values()]
      .map((lineage) => structuredClone(lineage))
      .sort((left, right) => left.root_tab_id - right.root_tab_id),
  });
}

async function readViolations(): Promise<BackgroundUiViolation[]> {
  const stored = await chrome.storage.session.get(BACKGROUND_UI_VIOLATIONS_KEY);
  const value = stored[BACKGROUND_UI_VIOLATIONS_KEY];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isBackgroundUiViolation)) {
    throw new Error("Chrome background UI violation ledger is malformed");
  }
  return structuredClone(value);
}

async function persistViolationsLocked(): Promise<void> {
  await chrome.storage.session.set({
    [BACKGROUND_UI_VIOLATIONS_KEY]: [...violations.values()]
      .map((violation) => structuredClone(violation))
      .sort((left, right) => left.tab_id - right.tab_id),
  });
}

function isBackgroundTargetGuard(
  value: unknown,
): value is BackgroundTargetGuard {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.target_id === "string" &&
    isTabId(record.tab_id) &&
    typeof record.owned === "boolean" &&
    isChromeUiState(record.safe_state) &&
    typeof record.page_mutated === "boolean" &&
    Array.isArray(record.descendant_tab_ids) &&
    record.descendant_tab_ids.every(isTabId)
  );
}

function isRetiredBackgroundLineage(
  value: unknown,
): value is RetiredBackgroundLineage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isTabId(record.root_tab_id) &&
    isChromeUiState(record.safe_state) &&
    Array.isArray(record.lineage_tab_ids) &&
    record.lineage_tab_ids.length > 0 &&
    record.lineage_tab_ids.length <= MAX_RETIRED_LINEAGE_TAB_IDS &&
    record.lineage_tab_ids.every(isTabId) &&
    record.lineage_tab_ids.includes(record.root_tab_id) &&
    typeof record.expires_at === "number" &&
    Number.isFinite(record.expires_at)
  );
}

function isChromeUiState(value: unknown): value is ChromeUiState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.window_ids) &&
    record.window_ids.every(isTabId) &&
    (record.focused_window_id === null || isTabId(record.focused_window_id)) &&
    Array.isArray(record.active_tabs) &&
    record.active_tabs.every((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return false;
      }
      const active = entry as Record<string, unknown>;
      return isTabId(active.window_id) && isTabId(active.tab_id);
    })
  );
}

function isBackgroundUiViolation(
  value: unknown,
): value is BackgroundUiViolation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.target_id === "string" &&
    isTabId(record.tab_id) &&
    typeof record.message === "string" &&
    typeof record.occurred_at === "string"
  );
}

function isTabId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isMissingTabError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no tab with id|invalid tab id|tab (?:was )?closed|target closed|missing tab/i.test(
    message,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
