/**
 * @owner       extension/src/chrome-controller.ts
 * @does        Execute broker-issued tab list/allocation/claim/finalize and page commands through Chrome APIs with background UI postconditions.
 * @needs       chrome.tabs, chrome.windows, chrome.debugger, chrome.cookies, extension network-capture.ts, src/browser/chrome-native-protocol.ts
 * @feeds       extension/src/background.ts
 * @breaks      Returns structured ChromeNativeError for absent windows/tabs, unsupported surfaces, debugger/CDP failure, and background postcondition changes.
 * @invariants  Background never calls windows.create, activates a tab, focuses a window, or accepts changed window/focus/active-tab state.
 * @side-effects Creates inactive tabs only in existing windows, claims tabs, dispatches CDP/page mutations, detaches debuggers, and closes owned targets on finalize.
 * @perf        Background verification adds two windows/tabs snapshots per mutation; page commands otherwise map to direct Chrome API/CDP calls.
 * @concurrency The native host is sequential and broker target queues serialize mutations; Chrome event listeners are removed on load or timeout.
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
import type { BrowserPageCommand } from "../../src/browser/runtime-protocol.js";
import { getChromeBrowserSessionId } from "./browser-session.js";
import { readDialogSnapshot, respondToDialog } from "./dialog-supervisor.js";
import { readNetworkCapture, startNetworkCapture } from "./network-capture.js";

interface ChromeUiState {
  window_ids: number[];
  focused_window_id: number | null;
  active_tabs: Array<{ window_id: number; tab_id: number }>;
}

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
): Promise<ChromeNativeResult> {
  try {
    validateCommandEnvelope(command);
    const data = await executeChromeCommand(command);
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
): Promise<unknown> {
  switch (command.action) {
    case "tabs.list":
      return listTabsWithoutUiChange();
    case "target.allocate":
      return allocateTarget(command.visibility);
    case "target.claim":
      return claimTarget(command.tab_id, command.visibility);
    case "target.finalize":
      return finalizeTarget(
        command.target_id,
        command.tab_id,
        command.visibility,
        command.disposition,
      );
    case "page.command":
      return executeTargetPageCommand(
        command.target_id,
        command.tab_id,
        command.visibility,
        command.command,
      );
  }
}

async function listTabsWithoutUiChange(): Promise<ChromeNativeTab[]> {
  const before = await captureUiState();
  const normalWindowIds = new Set(before.window_ids);
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
  visibility: "background" | "foreground",
): Promise<ChromeNativeTarget> {
  if (visibility === "background") return allocateBackgroundTarget();
  const windows = await normalWindows();
  if (windows.length === 0) {
    const created = await chrome.windows.create({
      type: "normal",
      focused: true,
      url: "about:blank",
    });
    const tab = created?.tabs?.[0];
    if (!created || created.id === undefined || tab?.id === undefined) {
      throw controllerError(
        "chrome_target_create_failed",
        "Chrome did not return a window and tab for foreground allocation",
      );
    }
    return targetFromTab(tab, created.id, true, "foreground");
  }
  const window = windows.find((candidate) => candidate.focused) ?? windows[0];
  const tab = await chrome.tabs.create({
    windowId: window.id,
    url: "about:blank",
    active: true,
  });
  await chrome.windows.update(window.id, { focused: true });
  return targetFromTab(tab, window.id, true, "foreground");
}

async function allocateBackgroundTarget(): Promise<ChromeNativeTarget> {
  const before = await captureUiState();
  const windows = await normalWindows();
  const window = windows.find((candidate) => candidate.focused) ?? windows[0];
  if (!window) {
    throw new ChromeControllerError(
      "background_unavailable",
      "Chrome has no existing normal window for an inactive task tab",
      "Open Chrome explicitly, or use the managed hidden provider without opening Chrome.",
      false,
    );
  }
  const tab = await chrome.tabs.create({
    windowId: window.id,
    url: "about:blank",
    active: false,
  });
  if (tab.active === true) {
    return failBackgroundAllocation(
      tab.id,
      new ChromeControllerError(
        "background_postcondition_failed",
        "Chrome activated a tab requested as background",
        "Keep the target closed and use the managed hidden provider until Chrome background allocation is available.",
        false,
      ),
    );
  }
  try {
    await assertUiStateUnchanged(before, "target.allocate");
  } catch (error) {
    return failBackgroundAllocation(tab.id, error);
  }
  return targetFromTab(tab, window.id, true, "background");
}

async function claimTarget(
  tabId: number,
  visibility: "background" | "foreground",
): Promise<ChromeNativeTarget> {
  const before = visibility === "background" ? await captureUiState() : null;
  const tab = await readSupportedTab(tabId);
  if (visibility === "foreground") {
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else if (before) {
    await assertUiStateUnchanged(before, "target.claim");
  }
  return targetFromTab(tab, tab.windowId, false, visibility);
}

async function finalizeTarget(
  targetId: string,
  tabId: number,
  visibility: "background" | "foreground",
  disposition: "close" | "release",
): Promise<void> {
  await assertTargetIdentity(targetId, tabId);
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
  await detachDebugger(tabId);
  if (disposition === "close") await chrome.tabs.remove(tabId);
  if (before) await assertUiStateUnchanged(before, "target.finalize");
}

async function executeTargetPageCommand(
  targetId: string,
  tabId: number,
  visibility: "background" | "foreground",
  command: BrowserPageCommand,
): Promise<unknown> {
  await assertTargetIdentity(targetId, tabId);
  const tab = await readSupportedTab(tabId);
  const before = visibility === "background" ? await captureUiState() : null;
  if (visibility === "foreground") {
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  const result = await executePageCommand(tabId, command);
  if (before) {
    await assertUiStateUnchanged(before, `page.${command.method}`);
  }
  return result;
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
      await click(tabId, command.selector);
      return undefined;
    case "type":
      await click(tabId, command.selector);
      await sendDebuggerCommand(tabId, "Input.insertText", {
        text: command.text,
      });
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
      return sendDebuggerCommand(tabId, "Accessibility.getFullAXTree", {
        ...command.options,
      });
    case "screenshot":
      return readScreenshotData(
        await sendDebuggerCommand(tabId, "Page.captureScreenshot", {
          format: command.format ?? "png",
          ...(command.quality === undefined
            ? {}
            : { quality: command.quality }),
          captureBeyondViewport: command.full_page === true,
          fromSurface: true,
          ...(command.clip ? { clip: { ...command.clip, scale: 1 } } : {}),
        }),
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
      await startNetworkCapture(tabId, command.pattern);
      return true;
    case "network_capture_read":
      return readNetworkCapture(tabId);
    case "downloads_read":
      return readDownloads(command.limit);
    case "dialog_read":
      return readDialogSnapshot(tabId, {
        clearRecent: command.clear_recent === true,
      });
    case "dialog_respond":
      return respondToDialog(tabId, {
        action: command.action,
        ...(command.prompt_text === undefined
          ? {}
          : { promptText: command.prompt_text }),
        ...(command.dialog_id === undefined
          ? {}
          : { dialogId: command.dialog_id }),
      });
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

async function captureUiState(): Promise<ChromeUiState> {
  const windows = await normalWindows();
  const windowIds = windows.map((window) => window.id).sort((a, b) => a - b);
  const normalWindowIds = new Set(windowIds);
  const activeTabs = (await chrome.tabs.query({ active: true }))
    .filter(
      (tab): tab is chrome.tabs.Tab & { id: number; windowId: number } =>
        typeof tab.id === "number" &&
        typeof tab.windowId === "number" &&
        normalWindowIds.has(tab.windowId),
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

async function assertUiStateUnchanged(
  before: ChromeUiState,
  action: string,
): Promise<void> {
  const after = await captureUiState();
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new ChromeControllerError(
      "background_postcondition_failed",
      `Chrome UI state changed during ${action}: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
      "Stop background work on this target and use the managed hidden provider or explicit foreground visibility.",
      false,
    );
  }
}

async function navigateTab(tabId: number, url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = (error?: Error): void => {
      chrome.tabs.onUpdated.removeListener(listener);
      if (timeout) clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const listener = (
      updatedTabId: number,
      info: chrome.tabs.OnUpdatedInfo,
    ): void => {
      if (updatedTabId === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    timeout = setTimeout(
      () =>
        finish(
          controllerError(
            "chrome_navigation_timeout",
            `Chrome target ${String(tabId)} did not finish navigation within ${String(NAVIGATION_TIMEOUT_MS)}ms`,
          ),
        ),
      NAVIGATION_TIMEOUT_MS,
    );
    chrome.tabs
      .update(tabId, { url })
      .catch((error: unknown) =>
        finish(error instanceof Error ? error : new Error(String(error))),
      );
  });
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

async function click(tabId: number, selector: string): Promise<void> {
  const document = (await sendDebuggerCommand(
    tabId,
    "DOM.getDocument",
  )) as DomDocumentResult;
  const rootNodeId = document.root?.nodeId;
  if (!rootNodeId) {
    throw controllerError(
      "chrome_selector_not_found",
      "Chrome did not return a DOM root node",
    );
  }
  const query = (await sendDebuggerCommand(tabId, "DOM.querySelector", {
    nodeId: rootNodeId,
    selector,
  })) as DomQueryResult;
  if (!query.nodeId) {
    throw controllerError(
      "chrome_selector_not_found",
      `Chrome selector did not match an element: ${selector}`,
    );
  }
  const box = (await sendDebuggerCommand(tabId, "DOM.getBoxModel", {
    nodeId: query.nodeId,
  })) as DomBoxResult;
  const content = box.model?.content;
  if (!content || content.length < 8) {
    throw controllerError(
      "chrome_selector_not_interactable",
      `Chrome selector has no interactable box: ${selector}`,
    );
  }
  const x = (content[0] + content[2] + content[4] + content[6]) / 4;
  const y = (content[1] + content[3] + content[5] + content[7]) / 4;
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

async function press(
  tabId: number,
  key: string,
  modifiers?: string[],
): Promise<void> {
  const modifierMask = (modifiers ?? []).reduce((mask, modifier) => {
    const value = {
      alt: 1,
      ctrl: 2,
      control: 2,
      meta: 4,
      command: 4,
      shift: 8,
    }[modifier.toLowerCase()];
    return mask | (value ?? 0);
  }, 0);
  const keyCode = key.length === 1 ? key.charCodeAt(0) : 0;
  const params = {
    key,
    code: key,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    ...(modifierMask ? { modifiers: modifierMask } : {}),
  };
  await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown",
    ...params,
  });
  await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    ...params,
  });
}

async function setFileInput(
  tabId: number,
  selector: string,
  files: string[],
): Promise<void> {
  const document = (await sendDebuggerCommand(
    tabId,
    "DOM.getDocument",
  )) as DomDocumentResult;
  const rootNodeId = document.root?.nodeId;
  if (!rootNodeId) {
    throw controllerError(
      "chrome_selector_not_found",
      "Chrome did not return a DOM root node",
    );
  }
  const query = (await sendDebuggerCommand(tabId, "DOM.querySelector", {
    nodeId: rootNodeId,
    selector,
  })) as DomQueryResult;
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
): Promise<unknown> {
  await ensureDebuggerAttached(tabId);
  const target = { tabId, ...(sessionId ? { sessionId } : {}) };
  try {
    return await chrome.debugger.sendCommand(target, method, params);
  } catch (error) {
    if (!isDebuggerDetachError(error)) throw error;
    attachedTabs.delete(tabId);
    await ensureDebuggerAttached(tabId);
    return chrome.debugger.sendCommand(target, method, params);
  }
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

async function failBackgroundAllocation(
  tabId: number | undefined,
  cause: unknown,
): Promise<never> {
  if (tabId === undefined) throw cause;
  try {
    await chrome.tabs.remove(tabId);
  } catch (cleanupError) {
    throw new ChromeControllerError(
      "background_cleanup_failed",
      `Chrome background allocation failed and tab ${String(tabId)} could not be removed: allocation=${errorMessage(cause)} cleanup=${errorMessage(cleanupError)}`,
      "Close the reported task tab manually, then use the managed hidden provider until Chrome background allocation is repaired.",
      false,
    );
  }
  throw cause;
}

async function readSupportedTab(tabId: number): Promise<chrome.tabs.Tab> {
  const tab = await chrome.tabs.get(tabId);
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
  constructor(
    readonly code: string,
    message: string,
    readonly suggestion: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ChromeControllerError";
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
  if (error instanceof ChromeControllerError) {
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
