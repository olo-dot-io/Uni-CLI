/**
 * @owner       extension/src/chrome-controller.ts
 * @does        Execute broker-issued tab inventory/content search, target allocation/claim/finalization, page commands, and foreground agent presence through Chrome APIs while delegating background lifetime ownership to one durable supervisor.
 * @needs       chrome.tabs/windows/debugger/scripting/history/cookies, extension background-supervisor.ts, content-search.ts, agent-presence.ts, debugger-dispatch.ts, dialog-supervisor.ts, target-ledger.ts, network-capture.ts, src/browser/chrome-native-protocol.ts, src/browser/key-descriptor.ts, src/browser/ref-target.ts
 * @feeds       extension/src/background.ts
 * @breaks      Returns structured ChromeNativeError for absent windows/tabs, unsupported surfaces, out-of-viewport coordinates, bounded-search failures, agent-presence failures, debugger/CDP failure, incomplete popup compensation, and background postcondition changes.
 * @invariants  Background never calls windows.create or mutates claimed tabs; content search is target-free and no-focus; agent presence requires an HTTP(S) foreground target; non-idempotent debugger commands never replay after ambiguous detach; canceled owned allocation cleans its late Chrome artifact and ledger; finalize removes presence before releasing user tabs.
 * @side-effects Creates inactive tabs only in existing windows, performs explicit isolated-world reads, claims tabs, dispatches CDP/page operations, renders explicit foreground presence, detaches debuggers, and closes owned targets on finalize.
 * @perf        Page commands map to direct Chrome API/CDP calls; content search is bounded in content-search.ts; agent presence has O(1) explicit updates and zero idle work; background postcondition cost belongs to background-supervisor.ts.
 * @concurrency The native host is sequential and broker target queues serialize mutations; debugger attach state is tab-scoped.
 * @test        tests/integration/browser-extension-background.test.ts, tests/unit/extension/network-capture.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import {
  chromeTargetId,
  type ChromeNativeCommand,
  type ChromeNativeError,
  type ChromeNativeResult,
  type ChromeNativeTab,
  type ChromeNativeTarget,
} from "../../src/browser/chrome-native-protocol.js";
import {
  browserPageCommandRequiresForegroundChrome,
  type BrowserPageCommand,
} from "../../src/browser/runtime-protocol.js";
import {
  BROWSER_VIEWPORT_EXPRESSION,
  BrowserViewportPointError,
  buildBrowserRefTargetExpression,
  readBrowserRefTargetResult,
  requireBrowserViewportPoint,
} from "../../src/browser/ref-target.js";
import { browserKeyEventPair } from "../../src/browser/key-descriptor.js";
import {
  AgentPresenceError,
  executeAgentPresenceCommand,
  removeAgentPresence,
} from "./agent-presence.js";
import { raceWithCancellation } from "./cancellable-operation.js";
import {
  ChromeContentSearchError,
  searchChromeContent,
} from "./content-search.js";
import {
  assertBackgroundTargetCanFinalize,
  assertChromeUiStateUnchanged as assertUiStateUnchanged,
  BackgroundCommandRecoveryError,
  BackgroundSupervisionError,
  captureChromeUiState as captureUiState,
  forgetBackgroundTargetSupervision,
  superviseBackgroundPageCommand,
  trackBackgroundTarget,
} from "./background-supervisor.js";
import { getChromeBrowserSessionId } from "./browser-session.js";
import { readDialogSnapshot, respondToDialog } from "./dialog-supervisor.js";
import type { DebuggerCommandDispatch } from "./debugger-dispatch.js";
import { readNetworkCapture, startNetworkCapture } from "./network-capture.js";
import {
  allocationMarker,
  beginOwnedAllocation,
  cancelOwnedAllocation,
  commitOwnedAllocation,
  forgetChromeTab,
  forgetChromeTarget,
  readChromeTarget,
  rememberChromeTarget,
} from "./target-ledger.js";

interface RuntimeEvaluateResult {
  result?: { value?: unknown };
  exceptionDetails?: {
    exception?: { description?: string };
    text?: string;
  };
}

interface DomDocumentResult {
  root?: { nodeId?: number };
}

interface DomQueryResult {
  nodeId?: number;
}

interface DomBoxResult {
  model?: { content?: number[] };
}

const attachedTabs = new Set<number>();
const NAVIGATION_TIMEOUT_MS = 30_000;
let debuggerLifecycleListenersRegistered = false;

registerDebuggerLifecycleListeners();

export async function handleChromeNativeCommand(
  command: ChromeNativeCommand,
  signal?: AbortSignal,
): Promise<ChromeNativeResult> {
  try {
    validateCommandEnvelope(command);
    signal?.throwIfAborted();
    const data = await executeChromeCommand(command, signal);
    signal?.throwIfAborted();
    return {
      type: "result",
      request_id: command.request_id,
      ok: true,
      ...(data === undefined ? {} : { data }),
    };
  } catch (error) {
    return {
      type: "result",
      request_id: command.request_id,
      ok: false,
      error: readControllerError(error),
    };
  }
}

async function executeChromeCommand(
  command: ChromeNativeCommand,
  signal?: AbortSignal,
): Promise<unknown> {
  switch (command.action) {
    case "tabs.list":
      return listTabsWithoutUiChange();
    case "content.search":
      return searchChromeContent(
        command.search,
        {
          capture: captureUiState,
          assertUnchanged: assertUiStateUnchanged,
        },
        signal,
      );
    case "target.allocate":
      return allocateTarget(command.request_id, command.visibility, signal);
    case "target.claim":
      return claimTarget(command.tab_id, command.visibility, signal);
    case "target.finalize":
      return finalizeTarget(
        command.target_id,
        command.tab_id,
        command.visibility,
        command.disposition,
        signal,
      );
    case "page.command":
      return executeTargetPageCommand(
        command.target_id,
        command.tab_id,
        command.visibility,
        command.command,
        signal,
      );
  }
}

async function listTabsWithoutUiChange(): Promise<ChromeNativeTab[]> {
  const before = await captureUiState();
  const normalWindowIds = new Set(
    (await normalWindows()).map((window) => window.id),
  );
  const tabs = await chrome.tabs.query({});
  const result = tabs
    .filter(
      (tab): tab is chrome.tabs.Tab & { id: number; windowId: number } =>
        typeof tab.id === "number" &&
        typeof tab.windowId === "number" &&
        normalWindowIds.has(tab.windowId) &&
        isSupportedTabUrl(tab.url),
    )
    .map((tab) => ({
      tab_id: tab.id,
      window_id: tab.windowId,
      ...(tab.url ? { url: tab.url } : {}),
      ...(tab.title ? { title: tab.title } : {}),
      active: tab.active === true,
      ...(typeof tab.lastAccessed === "number"
        ? { last_accessed: tab.lastAccessed }
        : {}),
    }))
    .sort(
      (left, right) => (right.last_accessed ?? 0) - (left.last_accessed ?? 0),
    );
  await assertUiStateUnchanged(before, "tabs.list");
  return result;
}

async function allocateTarget(
  requestId: string,
  visibility: "background" | "foreground",
  signal?: AbortSignal,
): Promise<ChromeNativeTarget> {
  if (visibility === "background") {
    return allocateBackgroundTarget(requestId, signal);
  }
  signal?.throwIfAborted();
  const windows = await normalWindows();
  signal?.throwIfAborted();
  const window = windows.find((candidate) => candidate.focused) ?? windows[0];
  await persistLedger(
    beginOwnedAllocation(requestId, visibility, window?.id),
    "begin foreground allocation",
  );
  signal?.throwIfAborted();
  let createdTabId: number | undefined;
  let createdWindowId: number | undefined;
  try {
    let tab: chrome.tabs.Tab;
    let windowId: number;
    if (!window) {
      const created = await chrome.windows.create({
        type: "normal",
        focused: true,
        url: allocationMarker(requestId),
      });
      createdWindowId = created?.id;
      const createdTab = created?.tabs?.[0];
      createdTabId = createdTab?.id;
      signal?.throwIfAborted();
      if (
        !created ||
        created.id === undefined ||
        createdTab?.id === undefined
      ) {
        throw controllerError(
          "chrome_target_create_failed",
          "Chrome did not return a window and tab for foreground allocation",
        );
      }
      tab = createdTab;
      windowId = created.id;
    } else {
      tab = await chrome.tabs.create({
        windowId: window.id,
        url: allocationMarker(requestId),
        active: true,
      });
      createdTabId = tab.id;
      signal?.throwIfAborted();
      windowId = window.id;
      await chrome.windows.update(window.id, { focused: true });
      signal?.throwIfAborted();
    }
    createdTabId = tab.id;
    const target = await targetFromTab(tab, windowId, true, "foreground");
    signal?.throwIfAborted();
    await persistLedger(
      commitOwnedAllocation(requestId, target),
      "commit foreground allocation",
    );
    signal?.throwIfAborted();
    return target;
  } catch (error) {
    return failOwnedAllocation(requestId, createdTabId, createdWindowId, error);
  }
}

async function allocateBackgroundTarget(
  requestId: string,
  signal?: AbortSignal,
): Promise<ChromeNativeTarget> {
  signal?.throwIfAborted();
  const before = await captureUiState();
  signal?.throwIfAborted();
  const windows = await normalWindows();
  signal?.throwIfAborted();
  const window = windows.find((candidate) => candidate.focused) ?? windows[0];
  if (!window) {
    throw new ChromeControllerError(
      "background_unavailable",
      "Chrome has no existing normal window for an inactive task tab",
      "Open Chrome explicitly, or use the managed hidden provider without opening Chrome.",
      false,
    );
  }
  await persistLedger(
    beginOwnedAllocation(requestId, "background", window.id),
    "begin background allocation",
  );
  signal?.throwIfAborted();
  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({
      windowId: window.id,
      url: allocationMarker(requestId),
      active: false,
    });
    tabId = tab.id;
    signal?.throwIfAborted();
    if (tab.active === true) {
      throw new ChromeControllerError(
        "background_postcondition_failed",
        "Chrome activated a tab requested as background",
        "Keep the target closed and use the managed hidden provider until Chrome background allocation is available.",
        false,
      );
    }
    await assertUiStateUnchanged(before, "target.allocate");
    signal?.throwIfAborted();
    const target = await targetFromTab(tab, window.id, true, "background");
    signal?.throwIfAborted();
    await persistLedger(
      commitOwnedAllocation(requestId, target),
      "commit background allocation",
    );
    await trackBackgroundTarget(target, before);
    signal?.throwIfAborted();
    return target;
  } catch (error) {
    return failOwnedAllocation(requestId, tabId, undefined, error);
  }
}

async function claimTarget(
  tabId: number,
  visibility: "background" | "foreground",
  signal?: AbortSignal,
): Promise<ChromeNativeTarget> {
  signal?.throwIfAborted();
  const before = visibility === "background" ? await captureUiState() : null;
  const tab = await readSupportedTab(tabId);
  signal?.throwIfAborted();
  if (visibility === "foreground") {
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    signal?.throwIfAborted();
  } else if (before) {
    await assertUiStateUnchanged(before, "target.claim");
    signal?.throwIfAborted();
  }
  const target = await targetFromTab(tab, tab.windowId, false, visibility);
  await persistLedger(rememberChromeTarget(target), "remember claimed target");
  try {
    if (before) await trackBackgroundTarget(target, before);
    else
      await forgetBackgroundTargetSupervision(target.target_id, target.tab_id);
  } catch (error) {
    await persistLedger(
      forgetChromeTarget(target.target_id),
      "roll back an unsupervised claimed target",
    );
    throw error;
  }
  signal?.throwIfAborted();
  return target;
}

async function finalizeTarget(
  targetId: string,
  tabId: number,
  visibility: "background" | "foreground",
  disposition: "close" | "release",
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await assertTargetIdentity(targetId, tabId);
  let existingTab: chrome.tabs.Tab;
  try {
    existingTab = await readExistingTab(tabId);
  } catch (error) {
    if (!isMissingTabError(error)) throw error;
    await persistLedger(
      forgetChromeTarget(targetId),
      "forget already-closed target",
    );
    await forgetBackgroundTargetSupervision(targetId, tabId);
    return;
  }
  if (visibility === "background") {
    await assertBackgroundTargetCanFinalize(targetId, tabId, disposition);
  }
  const before = visibility === "background" ? await captureUiState() : null;
  if (
    disposition === "close" &&
    before?.active_tabs.some((active) => active.tab_id === tabId)
  ) {
    throw new ChromeControllerError(
      "background_target_active",
      `Chrome target ${targetId} became active and cannot be closed without switching the user's tab`,
      "Finalize it with explicit foreground visibility or release the tab without closing it.",
      false,
    );
  }
  if (
    disposition === "release" &&
    visibility === "foreground" &&
    isAgentPresenceEligibleUrl(existingTab.url)
  ) {
    await removeAgentPresence(tabId, signal);
  }
  try {
    await detachDebugger(tabId);
    if (disposition === "close") await chrome.tabs.remove(tabId);
    signal?.throwIfAborted();
  } catch (error) {
    if (!isMissingTabError(error)) throw error;
  }
  if (before) await assertUiStateUnchanged(before, "target.finalize");
  await persistLedger(forgetChromeTarget(targetId), "forget finalized target");
  await forgetBackgroundTargetSupervision(targetId, tabId);
  signal?.throwIfAborted();
}

async function executeTargetPageCommand(
  targetId: string,
  tabId: number,
  visibility: "background" | "foreground",
  command: BrowserPageCommand,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  if (
    browserPageCommandRequiresForegroundChrome(command) &&
    visibility !== "foreground"
  ) {
    throw new ChromeControllerError(
      "chrome_agent_presence_requires_foreground",
      `Chrome page.${command.method} requires explicit foreground visibility`,
      "Claim or allocate the target with foreground visibility; hidden/background work never renders page presence.",
      false,
    );
  }
  await assertTargetIdentity(targetId, tabId);
  const trackedTarget = await readChromeTarget(targetId);
  if (!trackedTarget || trackedTarget.tab_id !== tabId) {
    throw new ChromeControllerError(
      "chrome_target_invalid",
      `Chrome target ${targetId} is not present in the durable target ledger`,
      "List, allocate, or claim the tab again through the current broker session.",
      false,
      false,
      { targetUnusable: true },
    );
  }
  const tab = await readSupportedTab(tabId);
  if (
    browserPageCommandRequiresForegroundChrome(command) &&
    !isAgentPresenceEligibleUrl(tab.url)
  ) {
    throw new ChromeControllerError(
      "chrome_agent_presence_unsupported",
      `Chrome page.${command.method} requires an HTTP(S) document`,
      "Navigate the explicit foreground target to a normal web page before rendering agent presence.",
      false,
    );
  }
  const before = visibility === "background" ? await captureUiState() : null;
  if (visibility === "foreground") {
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    try {
      const result = await raceWithCancellation(
        () => executePageCommand(tabId, command),
        signal,
      );
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      if (!signal?.aborted) throw error;
      await invalidateCancelledForegroundTarget(trackedTarget);
      throw new ChromeControllerError(
        "chrome_command_cancelled",
        `Chrome foreground page.${command.method} was cancelled after dispatch; its target was invalidated`,
        "Continue on a newly allocated or claimed Chrome target.",
        false,
        true,
        { cause: error, targetUnusable: true },
      );
    }
  }
  try {
    const result = await superviseBackgroundPageCommand(
      targetId,
      tabId,
      command,
      before!,
      () => executePageCommand(tabId, command),
      signal,
    );
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    if (error instanceof BackgroundCommandRecoveryError) {
      throw combineCommandAndBackgroundFailure(
        error.commandError,
        error.backgroundError,
      );
    }
    throw error;
  }
}

async function invalidateCancelledForegroundTarget(
  target: ChromeNativeTarget,
): Promise<void> {
  const errors: unknown[] = [];
  if (!target.owned) {
    try {
      const tab = await readExistingTab(target.tab_id);
      if (isAgentPresenceEligibleUrl(tab.url)) {
        await removeAgentPresence(target.tab_id);
      }
    } catch (error) {
      if (!isMissingTabError(error)) errors.push(error);
    }
  }
  try {
    await detachDebugger(target.tab_id);
  } catch (error) {
    errors.push(error);
  }
  if (target.owned) {
    try {
      await chrome.tabs.remove(target.tab_id);
    } catch (error) {
      if (!isMissingTabError(error)) errors.push(error);
    }
  }
  if (errors.length > 0 && !target.owned) {
    throw new ChromeControllerError(
      "chrome_target_invalidation_failed",
      `Cancelled Chrome target ${target.target_id} could not remove foreground presence: ${errors.map(errorMessage).join("; ")}`,
      "Retry target finalization after the page permits isolated-world cleanup.",
      false,
      true,
      {
        cause: new AggregateError(errors, "Foreground presence cleanup failed"),
        targetUnusable: true,
      },
    );
  }
  try {
    await persistLedger(
      forgetChromeTarget(target.target_id),
      "invalidate cancelled foreground target",
    );
    await forgetBackgroundTargetSupervision(target.target_id, target.tab_id);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new ChromeControllerError(
      "chrome_target_invalidation_failed",
      `Cancelled Chrome target ${target.target_id} could not be fully invalidated: ${errors.map(errorMessage).join("; ")}`,
      "Reload the Uni-CLI extension and reconcile targets before continuing.",
      false,
      true,
      {
        cause: new AggregateError(errors, "Foreground invalidation failed"),
        targetUnusable: true,
      },
    );
  }
}

function combineCommandAndBackgroundFailure(
  commandError: unknown,
  backgroundError: unknown,
): ChromeControllerError {
  const source =
    commandError instanceof ChromeControllerError
      ? commandError
      : new ChromeControllerError(
          "chrome_command_failed",
          errorMessage(commandError),
          "Inspect the Chrome extension debugger permission and target state before retrying.",
          false,
          controllerOutcomeIsAmbiguous(commandError),
          { cause: commandError },
        );
  return new ChromeControllerError(
    source.code,
    `${source.message}; background recovery failed: ${errorMessage(backgroundError)}`,
    source.suggestion,
    false,
    source.outcomeAmbiguous || controllerOutcomeIsAmbiguous(backgroundError),
    {
      cause: new AggregateError(
        [commandError, backgroundError],
        "Chrome command and background recovery both failed",
      ),
      targetUnusable: controllerTargetIsUnusable(backgroundError),
    },
  );
}

function controllerTargetIsUnusable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "targetUnusable" in error &&
    (error as { targetUnusable?: unknown }).targetUnusable === true
  );
}

async function executePageCommand(
  tabId: number,
  command: BrowserPageCommand,
): Promise<unknown> {
  switch (command.method) {
    case "navigate":
      await navigateTab(tabId, command.url);
      return undefined;
    case "evaluate":
      return evaluate(tabId, command.expression);
    case "click":
      await click(tabId, command.selector, command.snapshot_id);
      return undefined;
    case "native_click":
      await nativeClick(tabId, command.x, command.y);
      return undefined;
    case "type":
      await click(tabId, command.selector, command.snapshot_id);
      if ((command.mode ?? "insert_text") === "insert_text") {
        await sendDebuggerCommand(tabId, "Input.insertText", {
          text: command.text,
        });
      } else {
        await typeKeystrokes(tabId, command.text);
      }
      return undefined;
    case "press":
      await press(tabId, command.key, command.modifiers);
      return undefined;
    case "insert_text":
      await sendDebuggerCommand(tabId, "Input.insertText", {
        text: command.text,
      });
      return undefined;
    case "scroll":
      await evaluate(tabId, scrollExpression(command.direction));
      return undefined;
    case "cookies": {
      const result = (await sendDebuggerCommand(
        tabId,
        "Network.getCookies",
        {},
        undefined,
        true,
      )) as { cookies?: Array<{ name?: string; value?: string }> };
      return Object.fromEntries(
        (result.cookies ?? [])
          .filter(
            (cookie): cookie is { name: string; value: string } =>
              typeof cookie.name === "string" &&
              typeof cookie.value === "string",
          )
          .map((cookie) => [cookie.name, cookie.value]),
      );
    }
    case "title":
      return (await chrome.tabs.get(tabId)).title ?? "";
    case "url":
      return (await chrome.tabs.get(tabId)).url ?? "";
    case "snapshot":
      return sendDebuggerCommand(
        tabId,
        "Accessibility.getFullAXTree",
        {
          ...command.options,
        },
        undefined,
        true,
      );
    case "screenshot":
      return readScreenshotData(
        await sendDebuggerCommand(
          tabId,
          "Page.captureScreenshot",
          {
            format: command.format ?? "png",
            ...(command.quality === undefined
              ? {}
              : { quality: command.quality }),
            captureBeyondViewport: command.full_page === true,
            fromSurface: true,
            ...(command.clip ? { clip: { ...command.clip, scale: 1 } } : {}),
          },
          undefined,
          true,
        ),
      );
    case "cdp":
      return sendDebuggerCommand(
        tabId,
        command.cdp_method,
        command.params,
        command.session_id,
      );
    case "set_file_input":
      await setFileInput(tabId, command.selector, command.files);
      return undefined;
    case "network_capture_start":
      await startNetworkCapture(
        tabId,
        debuggerCommandDispatch(tabId),
        command.pattern,
      );
      return true;
    case "network_capture_read":
      return readNetworkCapture(tabId);
    case "downloads_read":
      return readDownloads(command.limit);
    case "dialog_read":
      return readDialogSnapshot(tabId, debuggerCommandDispatch(tabId), {
        clearRecent: command.clear_recent === true,
      });
    case "dialog_respond":
      return respondToDialog(tabId, debuggerCommandDispatch(tabId), {
        action: command.action,
        ...(command.prompt_text === undefined
          ? {}
          : { promptText: command.prompt_text }),
        ...(command.dialog_id === undefined
          ? {}
          : { dialogId: command.dialog_id }),
      });
    case "agent_presence":
    case "agent_cursor":
      return executeAgentPresenceCommand(tabId, command);
  }
}

async function readDownloads(limit = 20): Promise<Record<string, unknown>> {
  if (chrome.downloads === undefined) {
    throw controllerError(
      "chrome_downloads_unavailable",
      "chrome.downloads API is unavailable",
    );
  }
  const downloads = await chrome.downloads.search({
    limit,
    orderBy: ["-startTime"],
  });
  return {
    evidence_type: "browser-downloads",
    captured_at: new Date().toISOString(),
    limit,
    count: downloads.length,
    downloads: downloads.map(normalizeDownloadItem),
  };
}

function normalizeDownloadItem(
  item: chrome.downloads.DownloadItem,
): Record<string, unknown> {
  return {
    id: item.id,
    state: item.state,
    danger: item.danger,
    exists: item.exists,
    paused: item.paused,
    incognito: item.incognito,
    bytes_received: item.bytesReceived,
    total_bytes: item.totalBytes,
    file_size: item.fileSize,
    filename_basename: basenameOnly(item.filename),
    ...(item.mime ? { mime: item.mime } : {}),
    ...(item.url ? { url: item.url } : {}),
    ...(item.finalUrl ? { final_url: item.finalUrl } : {}),
    ...(item.startTime ? { started_at: item.startTime } : {}),
    ...(item.endTime ? { ended_at: item.endTime } : {}),
    ...(item.error ? { error: item.error } : {}),
  };
}

function basenameOnly(path: string): string {
  const normalized = path.split("\\").join("/");
  return normalized.split("/").filter(Boolean).at(-1)?.slice(0, 240) ?? "";
}

async function normalWindows(): Promise<
  Array<chrome.windows.Window & { id: number }>
> {
  return (await chrome.windows.getAll({ windowTypes: ["normal"] })).filter(
    (window): window is chrome.windows.Window & { id: number } =>
      typeof window.id === "number" &&
      (window.type === undefined || window.type === "normal"),
  );
}

async function navigateTab(tabId: number, url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let updateDispatched = false;
    let dispatchStartedAt = Number.POSITIVE_INFINITY;
    let navigationStarted = false;
    let committedDocumentId: string | null = null;
    let finished = false;
    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      chrome.webNavigation.onBeforeNavigate.removeListener(onBeforeNavigate);
      chrome.webNavigation.onCommitted.removeListener(onCommitted);
      chrome.webNavigation.onCompleted.removeListener(onCompleted);
      chrome.webNavigation.onErrorOccurred.removeListener(onErrorOccurred);
      chrome.webNavigation.onHistoryStateUpdated.removeListener(onSameDocument);
      chrome.webNavigation.onReferenceFragmentUpdated.removeListener(
        onSameDocument,
      );
      if (timeout) clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const isCurrentMainFrame = (details: {
      tabId: number;
      frameId: number;
      timeStamp: number;
    }): boolean =>
      updateDispatched &&
      details.tabId === tabId &&
      details.frameId === 0 &&
      details.timeStamp >= dispatchStartedAt;
    const onBeforeNavigate = (
      details: chrome.webNavigation.WebNavigationBaseCallbackDetails,
    ): void => {
      if (isCurrentMainFrame(details) && urlsEquivalent(details.url, url)) {
        navigationStarted = true;
      }
    };
    const onCommitted = (
      details: chrome.webNavigation.WebNavigationTransitionCallbackDetails,
    ): void => {
      if (!navigationStarted || !isCurrentMainFrame(details)) return;
      committedDocumentId = details.documentId;
    };
    const onCompleted = (
      details: chrome.webNavigation.WebNavigationFramedCallbackDetails,
    ): void => {
      if (
        committedDocumentId !== null &&
        isCurrentMainFrame(details) &&
        details.documentId === committedDocumentId
      ) {
        finish();
      }
    };
    const onErrorOccurred = (
      details: chrome.webNavigation.WebNavigationFramedErrorCallbackDetails,
    ): void => {
      if (
        committedDocumentId !== null &&
        isCurrentMainFrame(details) &&
        details.documentId === committedDocumentId
      ) {
        finish(
          new ChromeControllerError(
            "chrome_navigation_failed",
            `Chrome target ${String(tabId)} navigation failed: ${details.error}`,
            "Inspect the target URL and document state before navigating again.",
            false,
            true,
          ),
        );
      }
    };
    const onSameDocument = (
      details: chrome.webNavigation.WebNavigationTransitionCallbackDetails,
    ): void => {
      if (isCurrentMainFrame(details) && urlsEquivalent(details.url, url)) {
        finish();
      }
    };
    chrome.webNavigation.onBeforeNavigate.addListener(onBeforeNavigate);
    chrome.webNavigation.onCommitted.addListener(onCommitted);
    chrome.webNavigation.onCompleted.addListener(onCompleted);
    chrome.webNavigation.onErrorOccurred.addListener(onErrorOccurred);
    chrome.webNavigation.onHistoryStateUpdated.addListener(onSameDocument);
    chrome.webNavigation.onReferenceFragmentUpdated.addListener(onSameDocument);
    timeout = setTimeout(
      () =>
        finish(
          new ChromeControllerError(
            "chrome_navigation_timeout",
            `Chrome target ${String(tabId)} did not finish navigation within ${String(NAVIGATION_TIMEOUT_MS)}ms`,
            "Inspect the target URL before navigating again; Chrome accepted the update but did not confirm completion.",
            false,
            updateDispatched,
          ),
        ),
      NAVIGATION_TIMEOUT_MS,
    );
    try {
      dispatchStartedAt = Date.now();
      updateDispatched = true;
      const update = chrome.tabs.update(tabId, { url });
      void update.catch((error: unknown) =>
        finish(error instanceof Error ? error : new Error(String(error))),
      );
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function urlsEquivalent(left: string, right: string): boolean {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return left === right;
  }
}

async function evaluate(tabId: number, expression: string): Promise<unknown> {
  const result = (await sendDebuggerCommand(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    allowUnsafeEvalBlockedByCSP: true,
  })) as RuntimeEvaluateResult;
  if (result.exceptionDetails) {
    throw controllerError(
      "chrome_evaluate_failed",
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "Chrome evaluation failed",
    );
  }
  return result.result?.value;
}

async function click(
  tabId: number,
  selector: string,
  expectedSnapshotId?: string,
): Promise<void> {
  let x: number;
  let y: number;
  const refExpression = buildBrowserRefTargetExpression(
    selector,
    expectedSnapshotId,
  );
  if (expectedSnapshotId !== undefined && !refExpression) {
    throw controllerError(
      "chrome_ref_contract_invalid",
      "A snapshot id requires a ref-bearing selector",
    );
  }
  if (refExpression) {
    const target = readBrowserRefTargetResult(
      await evaluate(tabId, refExpression),
    );
    if (target.status !== "found") {
      throw controllerError(
        target.status === "stale" || target.status === "registry_unavailable"
          ? "stale_ref"
          : target.status === "selector_mismatch"
            ? "ref_not_found"
            : target.status === "unsupported_frame"
              ? "chrome_frame_unsupported"
              : target.status === "occluded"
                ? "browser_selector_occluded"
                : "chrome_selector_not_interactable",
        `Chrome ref ${target.ref} cannot be clicked: ${target.status}`,
      );
    }
    x = target.x;
    y = target.y;
  } else {
    const document = (await sendDebuggerCommand(
      tabId,
      "DOM.getDocument",
      {},
      undefined,
      true,
    )) as DomDocumentResult;
    const rootNodeId = document.root?.nodeId;
    if (!rootNodeId) {
      throw controllerError(
        "chrome_selector_not_found",
        "Chrome did not return a DOM root node",
      );
    }
    const query = (await sendDebuggerCommand(
      tabId,
      "DOM.querySelector",
      {
        nodeId: rootNodeId,
        selector,
      },
      undefined,
      true,
    )) as DomQueryResult;
    if (!query.nodeId) {
      throw controllerError(
        "chrome_selector_not_found",
        `Chrome selector did not match an element: ${selector}`,
      );
    }
    const box = (await sendDebuggerCommand(
      tabId,
      "DOM.getBoxModel",
      {
        nodeId: query.nodeId,
      },
      undefined,
      true,
    )) as DomBoxResult;
    const content = box.model?.content;
    if (!content || content.length < 8) {
      throw controllerError(
        "chrome_selector_not_interactable",
        `Chrome selector has no interactable box: ${selector}`,
      );
    }
    x = (content[0] + content[2] + content[4] + content[6]) / 4;
    y = (content[1] + content[3] + content[5] + content[7]) / 4;
  }
  await dispatchDebuggerInputPair(
    tabId,
    "Input.dispatchMouseEvent",
    {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    },
    {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    },
  );
}

async function press(
  tabId: number,
  key: string,
  modifiers?: string[],
): Promise<void> {
  const events = browserKeyEventPair(key, modifiers);
  await dispatchDebuggerInputPair(
    tabId,
    "Input.dispatchKeyEvent",
    events.down,
    events.up,
  );
}

async function typeKeystrokes(tabId: number, text: string): Promise<void> {
  for (const character of text) {
    const key = character === "\n" ? "Enter" : character;
    const keyText = character === "\n" ? "\r" : character;
    await dispatchDebuggerInputPair(
      tabId,
      "Input.dispatchKeyEvent",
      { type: "keyDown", key, text: keyText },
      { type: "keyUp", key },
    );
  }
}

async function nativeClick(tabId: number, x: number, y: number): Promise<void> {
  requireBrowserViewportPoint(
    await evaluate(tabId, BROWSER_VIEWPORT_EXPRESSION),
    x,
    y,
  );
  await dispatchDebuggerInputPair(
    tabId,
    "Input.dispatchMouseEvent",
    {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    },
    {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    },
  );
}

async function dispatchDebuggerInputPair(
  tabId: number,
  method: "Input.dispatchMouseEvent" | "Input.dispatchKeyEvent",
  down: Record<string, unknown>,
  up: Record<string, unknown>,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await sendDebuggerCommand(tabId, method, down);
  } catch (error) {
    errors.push(error);
  }
  try {
    await sendDebuggerCommand(tabId, method, up, undefined, true);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new ChromeControllerError(
      "chrome_input_pair_failed",
      `Paired ${method} dispatch and compensating release both failed`,
      "Inspect the page input state before issuing another mutation.",
      false,
      errors.some(controllerOutcomeIsAmbiguous),
      {
        cause: new AggregateError(errors, `Paired ${method} dispatch failed`),
      },
    );
  }
}

async function setFileInput(
  tabId: number,
  selector: string,
  files: string[],
): Promise<void> {
  const document = (await sendDebuggerCommand(
    tabId,
    "DOM.getDocument",
    {},
    undefined,
    true,
  )) as DomDocumentResult;
  const rootNodeId = document.root?.nodeId;
  if (!rootNodeId) {
    throw controllerError(
      "chrome_selector_not_found",
      "Chrome did not return a DOM root node",
    );
  }
  const query = (await sendDebuggerCommand(
    tabId,
    "DOM.querySelector",
    {
      nodeId: rootNodeId,
      selector,
    },
    undefined,
    true,
  )) as DomQueryResult;
  if (!query.nodeId) {
    throw controllerError(
      "chrome_selector_not_found",
      `Chrome file selector did not match an element: ${selector}`,
    );
  }
  await sendDebuggerCommand(tabId, "DOM.setFileInputFiles", {
    nodeId: query.nodeId,
    files,
  });
}

async function sendDebuggerCommand(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string,
  replayOnDetach = false,
): Promise<unknown> {
  await ensureDebuggerAttached(tabId);
  const target = { tabId, ...(sessionId ? { sessionId } : {}) };
  try {
    return await chrome.debugger.sendCommand(target, method, params);
  } catch (error) {
    if (!isDebuggerDetachError(error)) throw error;
    attachedTabs.delete(tabId);
    if (!replayOnDetach) throw ambiguousDebuggerError(method, error);
    try {
      await ensureDebuggerAttached(tabId);
      return await chrome.debugger.sendCommand(target, method, params);
    } catch (retryError) {
      throw ambiguousDebuggerError(
        method,
        new AggregateError(
          [error, retryError],
          `Debugger retry failed for ${method}`,
        ),
      );
    }
  }
}

function debuggerCommandDispatch(tabId: number): DebuggerCommandDispatch {
  return (method, params, replayOnDetach) =>
    sendDebuggerCommand(tabId, method, params, undefined, replayOnDetach);
}

function ambiguousDebuggerError(
  method: string,
  cause: unknown,
): ChromeControllerError {
  return new ChromeControllerError(
    "chrome_command_failed",
    `${method} lost its debugger response after dispatch: ${errorMessage(cause)}`,
    "Inspect the target state before issuing another mutation; the debugger detached after command dispatch.",
    false,
    true,
    { cause },
  );
}

function controllerOutcomeIsAmbiguous(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "outcomeAmbiguous" in error &&
    (error as { outcomeAmbiguous?: unknown }).outcomeAmbiguous === true
  ) {
    return true;
  }
  if (error instanceof AggregateError) {
    return error.errors.some(controllerOutcomeIsAmbiguous);
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "cause" in error &&
    controllerOutcomeIsAmbiguous((error as { cause?: unknown }).cause)
  );
}

function registerDebuggerLifecycleListeners(): void {
  if (debuggerLifecycleListenersRegistered) return;
  debuggerLifecycleListenersRegistered = true;
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId !== undefined) attachedTabs.delete(source.tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => attachedTabs.delete(tabId));
}

function isDebuggerDetachError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not attached|debugger[^\n]*detach|detached while/i.test(message);
}

function isMissingTabError(error: unknown): boolean {
  if (
    error instanceof ChromeControllerError &&
    error.code === "chrome_target_not_found"
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /no tab with id|invalid tab id|tab (?:was )?closed|target closed/i.test(
    message,
  );
}

async function ensureDebuggerAttached(tabId: number): Promise<void> {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already attached/i.test(message)) throw error;
  }
  attachedTabs.add(tabId);
}

async function detachDebugger(tabId: number): Promise<void> {
  try {
    await chrome.debugger.detach({ tabId });
    attachedTabs.delete(tabId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not attached/i.test(message)) {
      attachedTabs.delete(tabId);
      return;
    }
    throw error;
  }
}

async function failOwnedAllocation(
  requestId: string,
  tabId: number | undefined,
  windowId: number | undefined,
  cause: unknown,
): Promise<never> {
  const cleanupErrors: unknown[] = [];
  let allocationArtifactRemoved = false;
  try {
    if (tabId !== undefined) await chrome.tabs.remove(tabId);
    else if (windowId !== undefined) await chrome.windows.remove(windowId);
    else {
      const marker = allocationMarker(requestId);
      const orphanedTabIds = (await chrome.tabs.query({}))
        .filter(
          (tab): tab is chrome.tabs.Tab & { id: number } =>
            tab.url === marker && typeof tab.id === "number",
        )
        .map((tab) => tab.id);
      for (const orphanedTabId of orphanedTabIds) {
        await chrome.tabs.remove(orphanedTabId);
      }
    }
    allocationArtifactRemoved = true;
  } catch (cleanupError) {
    if (isMissingTabError(cleanupError)) allocationArtifactRemoved = true;
    else cleanupErrors.push(cleanupError);
  }
  if (allocationArtifactRemoved) {
    try {
      if (tabId !== undefined) await forgetChromeTab(tabId);
      await cancelOwnedAllocation(requestId);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new ChromeControllerError(
      "chrome_target_cleanup_failed",
      `Chrome allocation failed and cleanup was incomplete: allocation=${errorMessage(cause)} cleanup=${cleanupErrors.map(errorMessage).join("; ")}`,
      "Reconnect the Uni-CLI extension so its retained allocation intent can reconcile and close any surviving task tab.",
      false,
    );
  }
  throw cause;
}

async function readSupportedTab(tabId: number): Promise<chrome.tabs.Tab> {
  const tab = await readExistingTab(tabId);
  if (!isSupportedTabUrl(tab.url)) {
    throw new ChromeControllerError(
      "chrome_target_unsupported",
      `Chrome tab ${String(tabId)} is not an http(s), file, or about page`,
      "Choose a normal web tab returned by chrome.tabs.list.",
      false,
    );
  }
  return tab;
}

async function readExistingTab(tabId: number): Promise<chrome.tabs.Tab> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (error) {
    throw new ChromeControllerError(
      "chrome_target_not_found",
      `Chrome tab ${String(tabId)} no longer exists: ${errorMessage(error)}`,
      "Allow Uni-CLI to allocate a replacement task tab, or claim another live tab.",
      true,
    );
  }
  return tab;
}

async function persistLedger(
  operation: Promise<void>,
  action: string,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    throw new ChromeControllerError(
      "chrome_target_ledger_failed",
      `Chrome target ledger could not ${action}: ${errorMessage(error)}`,
      "Reconnect or reload the Uni-CLI extension, then retry after target-ledger reconciliation succeeds.",
      true,
    );
  }
}

async function targetFromTab(
  tab: chrome.tabs.Tab,
  windowId: number,
  owned: boolean,
  visibility: "background" | "foreground",
): Promise<ChromeNativeTarget> {
  if (tab.id === undefined) {
    throw controllerError(
      "chrome_target_create_failed",
      "Chrome tab response has no id",
    );
  }
  const browserSessionId = await getChromeBrowserSessionId();
  return {
    target_id: chromeTargetId(browserSessionId, tab.id),
    tab_id: tab.id,
    window_id: windowId,
    owned,
    visibility,
    ...(tab.url ? { url: tab.url } : {}),
    ...(tab.title ? { title: tab.title } : {}),
  };
}

async function assertTargetIdentity(
  targetId: string,
  tabId: number,
): Promise<void> {
  const browserSessionId = await getChromeBrowserSessionId();
  if (targetId !== chromeTargetId(browserSessionId, tabId)) {
    throw new ChromeControllerError(
      "chrome_target_invalid",
      `Chrome target ${targetId} does not match tab ${String(tabId)}`,
      "List or claim the tab again through the current broker session.",
      false,
    );
  }
}

function validateCommandEnvelope(command: ChromeNativeCommand): void {
  if (
    command.type !== "command" ||
    typeof command.request_id !== "string" ||
    !command.request_id.trim()
  ) {
    throw controllerError(
      "chrome_provider_protocol_invalid",
      "Chrome native command envelope is invalid",
    );
  }
}

function isSupportedTabUrl(url: string | undefined): boolean {
  return url === undefined || /^(https?:|file:|about:blank(?:$|#))/i.test(url);
}

function isAgentPresenceEligibleUrl(url: string | undefined): boolean {
  return typeof url === "string" && /^https?:/i.test(url);
}

function scrollExpression(direction: "down" | "up" | "bottom" | "top"): string {
  return {
    down: "window.scrollBy(0, window.innerHeight)",
    up: "window.scrollBy(0, -window.innerHeight)",
    bottom: "window.scrollTo(0, document.body.scrollHeight)",
    top: "window.scrollTo(0, 0)",
  }[direction];
}

function readScreenshotData(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Record<string, unknown>).data !== "string"
  ) {
    throw controllerError(
      "chrome_screenshot_failed",
      "Chrome screenshot response has no base64 data",
    );
  }
  return (value as { data: string }).data;
}

class ChromeControllerError extends Error {
  readonly targetUnusable: boolean;

  constructor(
    readonly code: string,
    message: string,
    readonly suggestion: string,
    readonly retryable: boolean,
    readonly outcomeAmbiguous = false,
    options?: ErrorOptions & { targetUnusable?: boolean },
  ) {
    super(message, options);
    this.name = "ChromeControllerError";
    this.targetUnusable = options?.targetUnusable === true;
  }
}

function controllerError(code: string, message: string): ChromeControllerError {
  return new ChromeControllerError(
    code,
    message,
    "Inspect the Chrome target and native-host status before retrying the same command.",
    false,
  );
}

function readControllerError(error: unknown): ChromeNativeError {
  if (error instanceof BackgroundSupervisionError) {
    return {
      code: error.code,
      message: error.message,
      suggestion: error.suggestion,
      retryable: error.retryable,
      ...(error.outcomeAmbiguous ? { outcome_ambiguous: true } : {}),
      ...(error.targetUnusable ? { target_unusable: true } : {}),
    };
  }
  if (error instanceof ChromeControllerError) {
    return {
      code: error.code,
      message: error.message,
      suggestion: error.suggestion,
      retryable: error.retryable,
      ...(error.outcomeAmbiguous ? { outcome_ambiguous: true } : {}),
      ...(error.targetUnusable ? { target_unusable: true } : {}),
    };
  }
  if (
    error instanceof ChromeContentSearchError ||
    error instanceof AgentPresenceError
  ) {
    return {
      code: error.code,
      message: error.message,
      suggestion: error.suggestion,
      retryable: error.retryable,
      ...(error.outcomeAmbiguous ? { outcome_ambiguous: true } : {}),
    };
  }
  if (error instanceof BrowserViewportPointError) {
    return {
      code: error.code,
      message: error.message,
      suggestion: error.suggestion,
      retryable: error.retryable,
    };
  }
  return {
    code: "chrome_command_failed",
    message: error instanceof Error ? error.message : String(error),
    suggestion:
      "Inspect the Chrome extension debugger permission and target state before retrying.",
    retryable: false,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
