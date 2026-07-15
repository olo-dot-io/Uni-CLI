import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHROME_EXTENSION_ID,
  CHROME_NATIVE_HOST_NAME,
  CHROME_NATIVE_PRODUCT,
  CHROME_NATIVE_PROTOCOL,
  CHROME_NATIVE_PROTOCOL_VERSION,
  chromeTargetId,
  type ChromeNativeCommand,
} from "../../src/browser/chrome-native-protocol.js";

type Listener<T extends unknown[]> = (...args: T) => void;
const BROWSER_SESSION_ID = "018f4f68-6f5b-7b01-8c02-123456789abc";
let nextRequestId = 1;

beforeEach(() => {
  nextRequestId = 1;
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Chrome extension background visibility contract", () => {
  it("allocates, mutates, and closes an inactive tab without changing window focus or active tabs", async () => {
    const harness = installStatefulChrome();
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const before = harness.uiState();

    const allocated = await handleChromeNativeCommand(
      command({ action: "target.allocate", visibility: "background" }),
    );

    expect(allocated).toMatchObject({
      ok: true,
      data: {
        target_id: chromeTargetId(BROWSER_SESSION_ID, 11),
        tab_id: 11,
        window_id: 7,
        owned: true,
        visibility: "background",
      },
    });
    expect(harness.chrome.tabs.create).toHaveBeenCalledWith({
      windowId: 7,
      url: "about:blank",
      active: false,
    });
    expect(harness.chrome.windows.create).not.toHaveBeenCalled();
    expect(harness.uiState()).toEqual(before);

    const title = await handleChromeNativeCommand(
      command({
        action: "page.command",
        target_id: chromeTargetId(BROWSER_SESSION_ID, 11),
        tab_id: 11,
        visibility: "background",
        command: { method: "title" },
      }),
    );
    expect(title).toMatchObject({ ok: true, data: "about:blank" });
    expect(harness.uiState()).toEqual(before);

    const finalized = await handleChromeNativeCommand(
      command({
        action: "target.finalize",
        target_id: chromeTargetId(BROWSER_SESSION_ID, 11),
        tab_id: 11,
        visibility: "background",
        disposition: "close",
      }),
    );
    expect(finalized.ok).toBe(true);
    expect(harness.chrome.tabs.remove).toHaveBeenCalledWith(11);
    expect(harness.uiState()).toEqual(before);
  });

  it("returns background_unavailable without creating a window when Chrome has no normal window", async () => {
    const harness = installStatefulChrome({ windows: [], tabs: [] });
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");

    const result = await handleChromeNativeCommand(
      command({ action: "target.allocate", visibility: "background" }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "background_unavailable",
        retryable: false,
      },
    });
    expect(harness.chrome.windows.create).not.toHaveBeenCalled();
    expect(harness.chrome.tabs.create).not.toHaveBeenCalled();
  });

  it("removes a misallocated tab and refuses success when Chrome changes the active tab", async () => {
    const harness = installStatefulChrome({ activateBackgroundCreate: true });
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");

    const result = await handleChromeNativeCommand(
      command({ action: "target.allocate", visibility: "background" }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "background_postcondition_failed" },
    });
    expect(harness.chrome.tabs.remove).toHaveBeenCalledWith(11);
  });

  it("claims an existing user tab without activation and releases it without closing", async () => {
    const harness = installStatefulChrome();
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const before = harness.uiState();

    const claimed = await handleChromeNativeCommand(
      command({
        action: "target.claim",
        tab_id: 10,
        visibility: "background",
      }),
    );
    expect(claimed).toMatchObject({
      ok: true,
      data: {
        target_id: chromeTargetId(BROWSER_SESSION_ID, 10),
        owned: false,
      },
    });
    const released = await handleChromeNativeCommand(
      command({
        action: "target.finalize",
        target_id: chromeTargetId(BROWSER_SESSION_ID, 10),
        tab_id: 10,
        visibility: "background",
        disposition: "release",
      }),
    );
    expect(released.ok).toBe(true);
    expect(harness.chrome.tabs.remove).not.toHaveBeenCalledWith(10);
    expect(harness.uiState()).toEqual(before);
  });

  it("preserves download evidence and provider-owned dialog supervision without foreground changes", async () => {
    const harness = installStatefulChrome();
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const before = harness.uiState();

    const downloads = await handleChromeNativeCommand(
      command({
        action: "page.command",
        target_id: chromeTargetId(BROWSER_SESSION_ID, 10),
        tab_id: 10,
        visibility: "background",
        command: { method: "downloads_read", limit: 5 },
      }),
    );
    expect(downloads).toMatchObject({
      ok: true,
      data: {
        evidence_type: "browser-downloads",
        count: 1,
        limit: 5,
        downloads: [{ filename_basename: "export.csv" }],
      },
    });

    await handleChromeNativeCommand(
      command({
        action: "page.command",
        target_id: chromeTargetId(BROWSER_SESSION_ID, 10),
        tab_id: 10,
        visibility: "background",
        command: { method: "dialog_read" },
      }),
    );
    harness.debuggerOnEvent.emit(
      { tabId: 10 },
      "Page.javascriptDialogOpening",
      { type: "prompt", message: "Name?", defaultPrompt: "Ada" },
    );
    const dialog = await handleChromeNativeCommand(
      command({
        action: "page.command",
        target_id: chromeTargetId(BROWSER_SESSION_ID, 10),
        tab_id: 10,
        visibility: "background",
        command: { method: "dialog_read" },
      }),
    );
    expect(dialog).toMatchObject({
      ok: true,
      data: {
        evidence_type: "browser-dialog-supervision",
        pending_count: 1,
        pending_dialogs: [{ id: "d-1", message: "Name?" }],
      },
    });
    const responded = await handleChromeNativeCommand(
      command({
        action: "page.command",
        target_id: chromeTargetId(BROWSER_SESSION_ID, 10),
        tab_id: 10,
        visibility: "background",
        command: {
          method: "dialog_respond",
          action: "accept",
          prompt_text: "Grace",
          dialog_id: "d-1",
        },
      }),
    );
    expect(responded).toMatchObject({
      ok: true,
      data: { pending_count: 0, responded_dialog: { id: "d-1" } },
    });
    expect(harness.chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 10 },
      "Page.handleJavaScriptDialog",
      { accept: true, promptText: "Grace" },
    );
    expect(harness.uiState()).toEqual(before);
  });

  it("connects only through Native Messaging and correlates extension results", async () => {
    const harness = installStatefulChrome();

    await import("../../extension/src/background.js");

    expect(harness.chrome.runtime.connectNative).toHaveBeenCalledWith(
      CHROME_NATIVE_HOST_NAME,
    );
    expect(harness.nativeMessages[0]).toEqual({
      type: "hello",
      product: CHROME_NATIVE_PRODUCT,
      protocol: CHROME_NATIVE_PROTOCOL,
      version: CHROME_NATIVE_PROTOCOL_VERSION,
      extension_id: CHROME_EXTENSION_ID,
      extension_version: "1.0.0-test",
      browser_session_id: BROWSER_SESSION_ID,
    });
    harness.nativePort.onMessage.emit(command({ action: "tabs.list" }));
    await vi.waitFor(() =>
      expect(harness.nativeMessages).toContainEqual(
        expect.objectContaining({
          type: "result",
          ok: true,
          data: [
            expect.objectContaining({
              tab_id: 10,
              active: true,
            }),
          ],
        }),
      ),
    );
    expect(harness.chrome.windows.create).not.toHaveBeenCalled();
  });

  it("reuses targets across service-worker restarts but rejects them after a full browser-session change", async () => {
    const harness = installStatefulChrome();
    const firstController =
      await import("../../extension/src/chrome-controller.js");
    const allocated = await firstController.handleChromeNativeCommand(
      command({ action: "target.allocate", visibility: "background" }),
    );
    expect(allocated.ok).toBe(true);
    const target = allocated.data as {
      target_id: string;
      tab_id: number;
    };

    vi.resetModules();
    const restartedController =
      await import("../../extension/src/chrome-controller.js");
    await expect(
      restartedController.handleChromeNativeCommand(
        command({
          action: "page.command",
          target_id: target.target_id,
          tab_id: target.tab_id,
          visibility: "background",
          command: { method: "title" },
        }),
      ),
    ).resolves.toMatchObject({ ok: true });

    harness.setBrowserSessionId("018f4f68-6f5b-7b01-8c02-abcdefabcdef");
    vi.resetModules();
    const newBrowserController =
      await import("../../extension/src/chrome-controller.js");
    await expect(
      newBrowserController.handleChromeNativeCommand(
        command({
          action: "page.command",
          target_id: target.target_id,
          tab_id: target.tab_id,
          visibility: "background",
          command: { method: "title" },
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "chrome_target_invalid" },
    });
  });
});

function command(
  input: Omit<ChromeNativeCommand, "type" | "request_id">,
): ChromeNativeCommand {
  return {
    type: "command",
    request_id: `request:${String(nextRequestId++)}`,
    ...input,
  } as ChromeNativeCommand;
}

function createEvent<T extends unknown[]>() {
  const listeners: Listener<T>[] = [];
  return {
    addListener: vi.fn((listener: Listener<T>) => listeners.push(listener)),
    removeListener: vi.fn((listener: Listener<T>) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    }),
    emit: (...args: T) => {
      for (const listener of listeners.slice()) listener(...args);
    },
  };
}

function installStatefulChrome(
  options: {
    windows?: WindowState[];
    tabs?: TabState[];
    activateBackgroundCreate?: boolean;
  } = {},
) {
  const windows: WindowState[] = structuredClone(
    options.windows ?? [{ id: 7, focused: true, type: "normal" }],
  );
  const tabs: TabState[] = structuredClone(
    options.tabs ?? [
      {
        id: 10,
        windowId: 7,
        active: true,
        url: "https://example.com/",
        title: "Example",
        lastAccessed: 100,
      },
    ],
  );
  let nextTabId = 11;
  let nextWindowId = 8;
  const tabsOnUpdated = createEvent<[number, { status?: string }, TabState]>();
  const tabsOnRemoved = createEvent<[number]>();
  const debuggerOnEvent =
    createEvent<[{ tabId?: number }, string, Record<string, unknown>]>();
  const debuggerOnDetach = createEvent<[{ tabId?: number }, string]>();
  const runtimeOnInstalled = createEvent<[]>();
  const runtimeOnStartup = createEvent<[]>();
  const alarmsOnAlarm = createEvent<[{ name: string }]>();
  const nativeOnMessage = createEvent<[unknown]>();
  const nativeOnDisconnect = createEvent<[]>();
  const nativeMessages: unknown[] = [];
  let browserSessionId = BROWSER_SESSION_ID;
  const nativePort = {
    onMessage: nativeOnMessage,
    onDisconnect: nativeOnDisconnect,
    postMessage: vi.fn((message: unknown) => nativeMessages.push(message)),
  };

  const queryTabs = (query: Record<string, unknown>): TabState[] =>
    tabs.filter(
      (tab) =>
        (query.windowId === undefined || tab.windowId === query.windowId) &&
        (query.active === undefined || tab.active === query.active),
    );
  const activateTab = (tab: TabState): void => {
    for (const candidate of tabs) {
      if (candidate.windowId === tab.windowId) candidate.active = false;
    }
    tab.active = true;
  };
  const focusWindow = (windowId: number): void => {
    for (const candidate of windows)
      candidate.focused = candidate.id === windowId;
  };

  const chrome = {
    tabs: {
      query: vi.fn(async (query: Record<string, unknown>) =>
        structuredClone(queryTabs(query)),
      ),
      get: vi.fn(async (tabId: number) => {
        const tab = tabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error(`No tab with id ${String(tabId)}`);
        return structuredClone(tab);
      }),
      create: vi.fn(
        async (create: {
          windowId?: number;
          url?: string;
          active?: boolean;
        }) => {
          const windowId = create.windowId ?? windows[0]?.id;
          if (windowId === undefined) throw new Error("No target window");
          const tab: TabState = {
            id: nextTabId++,
            windowId,
            active:
              create.active === true ||
              options.activateBackgroundCreate === true,
            url: create.url ?? "about:blank",
            title: create.url ?? "about:blank",
            lastAccessed: Date.now(),
          };
          if (tab.active) activateTab(tab);
          tabs.push(tab);
          return structuredClone(tab);
        },
      ),
      update: vi.fn(
        async (tabId: number, update: { active?: boolean; url?: string }) => {
          const tab = tabs.find((candidate) => candidate.id === tabId);
          if (!tab) throw new Error(`No tab with id ${String(tabId)}`);
          if (update.active === true) activateTab(tab);
          if (update.url) {
            tab.url = update.url;
            tab.title = update.url;
            queueMicrotask(() =>
              tabsOnUpdated.emit(
                tabId,
                { status: "complete" },
                structuredClone(tab),
              ),
            );
          }
          return structuredClone(tab);
        },
      ),
      remove: vi.fn(async (tabId: number) => {
        const index = tabs.findIndex((candidate) => candidate.id === tabId);
        if (index < 0) throw new Error(`No tab with id ${String(tabId)}`);
        const [removed] = tabs.splice(index, 1);
        if (removed.active) {
          const replacement = tabs.find(
            (candidate) => candidate.windowId === removed.windowId,
          );
          if (replacement) replacement.active = true;
        }
        tabsOnRemoved.emit(tabId);
      }),
      onUpdated: tabsOnUpdated,
      onRemoved: tabsOnRemoved,
    },
    windows: {
      getAll: vi.fn(async () => structuredClone(windows)),
      update: vi.fn(async (windowId: number, update: { focused?: boolean }) => {
        if (update.focused === true) focusWindow(windowId);
        return structuredClone(
          windows.find((candidate) => candidate.id === windowId),
        );
      }),
      create: vi.fn(
        async (create: { focused?: boolean; url?: string; type?: string }) => {
          const window: WindowState = {
            id: nextWindowId++,
            focused: create.focused === true,
            type: "normal",
          };
          if (window.focused) focusWindow(window.id);
          windows.push(window);
          const tab: TabState = {
            id: nextTabId++,
            windowId: window.id,
            active: true,
            url: create.url ?? "about:blank",
            title: create.url ?? "about:blank",
          };
          tabs.push(tab);
          return { ...structuredClone(window), tabs: [structuredClone(tab)] };
        },
      ),
    },
    debugger: {
      attach: vi.fn().mockResolvedValue(undefined),
      detach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn(async (_target: unknown, method: string) => {
        if (method === "Runtime.evaluate") return { result: { value: true } };
        if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
        if (method === "DOM.querySelector") return { nodeId: 2 };
        if (method === "DOM.getBoxModel") {
          return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
        }
        return {};
      }),
      onEvent: debuggerOnEvent,
      onDetach: debuggerOnDetach,
    },
    cookies: { getAll: vi.fn().mockResolvedValue([]) },
    downloads: {
      search: vi.fn().mockResolvedValue([
        {
          id: 9,
          state: "complete",
          danger: "safe",
          exists: true,
          paused: false,
          incognito: false,
          bytesReceived: 256,
          totalBytes: 256,
          fileSize: 256,
          filename: "/Users/example/Downloads/export.csv",
          mime: "text/csv",
          url: "https://example.com/export.csv",
          finalUrl: "https://example.com/export.csv",
          startTime: "2026-07-15T00:00:00.000Z",
          endTime: "2026-07-15T00:00:01.000Z",
        },
      ]),
    },
    storage: {
      session: {
        get: vi.fn(async () => ({
          unicli_browser_session_id: browserSessionId,
        })),
        set: vi.fn().mockResolvedValue(undefined),
      },
    },
    alarms: { create: vi.fn(), onAlarm: alarmsOnAlarm },
    runtime: {
      id: CHROME_EXTENSION_ID,
      getManifest: vi.fn(() => ({ version: "1.0.0-test" })),
      connectNative: vi.fn(() => nativePort),
      onInstalled: runtimeOnInstalled,
      onStartup: runtimeOnStartup,
      lastError: undefined,
    },
  };
  vi.stubGlobal("chrome", chrome);
  return {
    chrome,
    nativeMessages,
    nativePort,
    debuggerOnEvent,
    setBrowserSessionId: (value: string) => {
      browserSessionId = value;
    },
    uiState: () => ({
      window_ids: windows.map((window) => window.id).sort((a, b) => a - b),
      focused_window_id: windows.find((window) => window.focused)?.id ?? null,
      active_tabs: tabs
        .filter((tab) => tab.active)
        .map((tab) => ({ window_id: tab.windowId, tab_id: tab.id }))
        .sort(
          (left, right) =>
            left.window_id - right.window_id || left.tab_id - right.tab_id,
        ),
    }),
  };
}

interface WindowState {
  id: number;
  focused: boolean;
  type: "normal";
}

interface TabState {
  id: number;
  windowId: number;
  active: boolean;
  url: string;
  title: string;
  lastAccessed?: number;
}
