/**
 * @owner   extension/src/dialog-supervisor.ts
 * @does    Maintain provider-owned browser JavaScript dialog state for broker-owned Chrome targets.
 * @needs   chrome.debugger events, chrome.tabs events, debugger-dispatch.ts
 * @feeds   extension/src/chrome-controller.ts dialog_read/dialog_respond commands
 * @breaks  extension dialog supervision tests when pending/recent dialog state, response routing, or debugger ambiguity propagation drifts.
 * @invariants Dialog mutations use the controller-owned non-replay debugger transport; Page.enable may replay after detach because it is idempotent.
 * @side-effects Enables Page dialog events, records bounded pending/recent evidence, and accepts or dismisses an explicitly selected dialog.
 * @concurrency Chrome events update per-tab state synchronously; native commands are serialized by the host and broker target queue.
 * @test    tests/integration/browser-extension-background.test.ts
 * @stability experimental
 * @since   2026-07-15
 */

import type { DebuggerCommandDispatch } from "./debugger-dispatch.js";

export type DialogSupervisorAction = "accept" | "dismiss";

export interface ExtensionDialogEntry {
  id: string;
  type: string;
  message: string;
  opened_at: string;
  url?: string;
  default_prompt?: string;
}

export interface ExtensionDialogRecord extends ExtensionDialogEntry {
  closed_at: string;
  closed_by: "agent" | "remote" | "tab_closed";
  action?: DialogSupervisorAction;
}

export interface ExtensionDialogSnapshot {
  ok: true;
  evidence_type: "browser-dialog-supervision";
  captured_at: string;
  supervision: "active";
  pending_count: number;
  recent_count: number;
  pending_dialogs: readonly ExtensionDialogEntry[];
  recent_dialogs: readonly ExtensionDialogRecord[];
}

interface DialogState {
  nextId: number;
  pending: Map<string, ExtensionDialogEntry>;
  recent: ExtensionDialogRecord[];
}

interface JavaScriptDialogOpeningParams {
  type?: string;
  message?: string;
  url?: string;
  defaultPrompt?: string;
}

const MAX_PENDING_DIALOGS = 10;
const MAX_RECENT_DIALOGS = 20;
const MAX_DIALOG_TEXT_CHARS = 1_000;

const dialogStates = new Map<number, DialogState>();
let listenersRegistered = false;

export async function readDialogSnapshot(
  tabId: number,
  dispatch: DebuggerCommandDispatch,
  opts?: { clearRecent?: boolean },
): Promise<ExtensionDialogSnapshot> {
  await ensureDialogSupervision(dispatch);
  const snapshot = snapshotDialogState(tabId);
  if (opts?.clearRecent === true) {
    stateForTab(tabId).recent = [];
  }
  return snapshot;
}

export async function respondToDialog(
  tabId: number,
  dispatch: DebuggerCommandDispatch,
  input: {
    action: DialogSupervisorAction;
    promptText?: string;
    dialogId?: string;
  },
): Promise<
  ExtensionDialogSnapshot & { responded_dialog: ExtensionDialogEntry }
> {
  await ensureDialogSupervision(dispatch);
  const state = stateForTab(tabId);
  const dialog = selectPendingDialog(state, input.dialogId);
  await dispatch(
    "Page.handleJavaScriptDialog",
    {
      accept: input.action === "accept",
      promptText: input.promptText ?? "",
    },
    false,
  );
  archiveDialog(tabId, dialog, "agent", input.action);
  return {
    ...(snapshotDialogState(tabId) as ExtensionDialogSnapshot),
    responded_dialog: dialog,
  };
}

async function ensureDialogSupervision(
  dispatch: DebuggerCommandDispatch,
): Promise<void> {
  registerDialogListeners();
  await dispatch("Page.enable", {}, true);
}

function registerDialogListeners(): void {
  if (listenersRegistered) return;
  listenersRegistered = true;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    if (method === "Page.javascriptDialogOpening") {
      handleDialogOpening(tabId, params as JavaScriptDialogOpeningParams);
      return;
    }
    if (method === "Page.javascriptDialogClosed") {
      closeOldestPendingDialog(tabId, "remote");
    }
  });
  chrome.debugger.onDetach.addListener((source) => clearTab(source.tabId));
  chrome.tabs.onRemoved.addListener((tabId) => clearTab(tabId));
}

function handleDialogOpening(
  tabId: number,
  params: JavaScriptDialogOpeningParams,
): void {
  const state = stateForTab(tabId);
  const dialog: ExtensionDialogEntry = {
    id: `d-${String(++state.nextId)}`,
    type: sanitizeDialogType(params.type),
    message: truncateDialogText(params.message ?? ""),
    opened_at: new Date().toISOString(),
    ...(params.url ? { url: truncateDialogText(params.url) } : {}),
    ...(params.defaultPrompt
      ? { default_prompt: truncateDialogText(params.defaultPrompt) }
      : {}),
  };
  state.pending.set(dialog.id, dialog);
  while (state.pending.size > MAX_PENDING_DIALOGS) {
    closeOldestPendingDialog(tabId, "remote");
  }
}

function selectPendingDialog(
  state: DialogState,
  dialogId: string | undefined,
): ExtensionDialogEntry {
  if (dialogId !== undefined) {
    const dialog = state.pending.get(dialogId);
    if (dialog === undefined) {
      throw new Error(`Dialog ${dialogId} is not pending.`);
    }
    return dialog;
  }
  const pending = [...state.pending.values()];
  if (pending.length === 0) {
    throw new Error("No browser dialog is pending.");
  }
  if (pending.length > 1) {
    throw new Error(
      `Multiple browser dialogs are pending. Specify dialog_id: ${pending
        .map((dialog) => dialog.id)
        .join(", ")}`,
    );
  }
  return pending[0]!;
}

function closeOldestPendingDialog(
  tabId: number,
  closedBy: ExtensionDialogRecord["closed_by"],
): void {
  const state = dialogStates.get(tabId);
  const dialog = state?.pending.values().next().value;
  if (dialog === undefined) return;
  archiveDialog(tabId, dialog, closedBy);
}

function archiveDialog(
  tabId: number,
  dialog: ExtensionDialogEntry,
  closedBy: ExtensionDialogRecord["closed_by"],
  action?: DialogSupervisorAction,
): void {
  const state = stateForTab(tabId);
  state.pending.delete(dialog.id);
  state.recent.push({
    ...dialog,
    closed_at: new Date().toISOString(),
    closed_by: closedBy,
    ...(action ? { action } : {}),
  });
  if (state.recent.length > MAX_RECENT_DIALOGS) {
    state.recent = state.recent.slice(-MAX_RECENT_DIALOGS);
  }
}

function snapshotDialogState(tabId: number): ExtensionDialogSnapshot {
  const state = stateForTab(tabId);
  const recent = state.recent.slice(-MAX_RECENT_DIALOGS);
  return {
    ok: true,
    evidence_type: "browser-dialog-supervision",
    captured_at: new Date().toISOString(),
    supervision: "active",
    pending_count: state.pending.size,
    recent_count: recent.length,
    pending_dialogs: [...state.pending.values()],
    recent_dialogs: recent,
  };
}

function stateForTab(tabId: number): DialogState {
  let state = dialogStates.get(tabId);
  if (state === undefined) {
    state = {
      nextId: 0,
      pending: new Map(),
      recent: [],
    };
    dialogStates.set(tabId, state);
  }
  return state;
}

function clearTab(tabId?: number): void {
  if (tabId === undefined) return;
  const state = dialogStates.get(tabId);
  if (state === undefined) return;
  for (const dialog of state.pending.values()) {
    archiveDialog(tabId, dialog, "tab_closed");
  }
  dialogStates.delete(tabId);
}

function sanitizeDialogType(value: string | undefined): string {
  const type = (value ?? "unknown").trim().toLowerCase();
  if (
    type === "alert" ||
    type === "confirm" ||
    type === "prompt" ||
    type === "beforeunload"
  ) {
    return type;
  }
  return "unknown";
}

function truncateDialogText(value: string): string {
  return value.length <= MAX_DIALOG_TEXT_CHARS
    ? value
    : value.slice(0, MAX_DIALOG_TEXT_CHARS);
}
