import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHROME_EXTENSION_ID,
  CHROME_NATIVE_COMMAND_DEADLINE_MS,
  CHROME_NATIVE_HOST_NAME,
  CHROME_NATIVE_PRODUCT,
  CHROME_NATIVE_PROTOCOL,
  CHROME_NATIVE_PROTOCOL_VERSION,
  chromeTargetId,
  type ChromeNativeCommand,
  type ChromeNativeResult,
  type ChromeNativeTarget,
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
      url: "about:blank#unicli-allocation=request%3A1",
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
    expect(title).toMatchObject({
      ok: true,
      data: "about:blank#unicli-allocation=request%3A1",
    });
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

  it("treats a user-closed task tab as already finalized", async () => {
    const harness = installStatefulChrome();
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const allocated = await handleChromeNativeCommand(
      command({ action: "target.allocate", visibility: "background" }),
    );
    expect(allocated).toMatchObject({ ok: true, data: { tab_id: 11 } });
    await harness.chrome.tabs.remove(11);

    const finalized = await handleChromeNativeCommand(
      command({
        action: "target.finalize",
        target_id: chromeTargetId(BROWSER_SESSION_ID, 11),
        tab_id: 11,
        visibility: "background",
        disposition: "close",
      }),
    );

    expect(finalized).toMatchObject({ ok: true });
  });

  it("preserves download evidence and provider-owned dialog supervision without foreground changes", async () => {
    const harness = installStatefulChrome();
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const before = harness.uiState();
    const target = await allocateOwnedBackgroundTarget(
      handleChromeNativeCommand,
    );

    const downloads = await handleChromeNativeCommand(
      command({
        action: "page.command",
        target_id: target.target_id,
        tab_id: target.tab_id,
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
        target_id: target.target_id,
        tab_id: target.tab_id,
        visibility: "background",
        command: { method: "dialog_read" },
      }),
    );
    harness.debuggerOnEvent.emit(
      { tabId: target.tab_id },
      "Page.javascriptDialogOpening",
      { type: "prompt", message: "Name?", defaultPrompt: "Ada" },
    );
    const dialog = await handleChromeNativeCommand(
      command({
        action: "page.command",
        target_id: target.target_id,
        tab_id: target.tab_id,
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
        target_id: target.target_id,
        tab_id: target.tab_id,
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
      { tabId: target.tab_id },
      "Page.handleJavaScriptDialog",
      { accept: true, promptText: "Grace" },
    );
    expect(harness.uiState()).toEqual(before);
  });

  it("connects only through Native Messaging and correlates extension results", async () => {
    const harness = installStatefulChrome();

    await import("../../extension/src/background.js");

    await vi.waitFor(() =>
      expect(harness.chrome.runtime.connectNative).toHaveBeenCalledWith(
        CHROME_NATIVE_HOST_NAME,
      ),
    );
    expect(harness.nativeMessages[0]).toEqual({
      type: "hello",
      product: CHROME_NATIVE_PRODUCT,
      protocol: CHROME_NATIVE_PROTOCOL,
      version: CHROME_NATIVE_PROTOCOL_VERSION,
      extension_id: CHROME_EXTENSION_ID,
      extension_version: "1.0.0-test",
      browser_session_id: BROWSER_SESSION_ID,
      targets: [],
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

  it("cleans a late owned allocation and reconciles again after abandoning its native generation", async () => {
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) =>
      realSetTimeout(
        callback,
        delay === CHROME_NATIVE_COMMAND_DEADLINE_MS || delay === 2_000
          ? 10
          : delay,
        ...args,
      )) as typeof setTimeout);
    let releaseCreate: (() => void) | undefined;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const harness = installStatefulChrome({ createGate });
    await import("../../extension/src/background.js");
    await vi.waitFor(() =>
      expect(harness.chrome.runtime.connectNative).toHaveBeenCalledTimes(1),
    );

    harness.nativePort.onMessage.emit(
      command({ action: "target.allocate", visibility: "background" }),
    );
    await vi.waitFor(() =>
      expect(harness.chrome.tabs.create).toHaveBeenCalledOnce(),
    );
    await vi.waitFor(() =>
      expect(
        harness.chrome.runtime.connectNative.mock.calls.length,
      ).toBeGreaterThanOrEqual(2),
    );

    releaseCreate?.();

    await vi.waitFor(() =>
      expect(
        harness.chrome.runtime.connectNative.mock.calls.length,
      ).toBeGreaterThanOrEqual(3),
    );
    await expect(harness.chrome.tabs.get(11)).rejects.toThrow(
      "No tab with id 11",
    );
    expect(harness.removedTabIds).toContain(11);
    expect(harness.targetLedger()).toEqual({ version: 1, entries: [] });
    const hellos = harness.nativeMessages.filter(
      (message): message is { type: "hello"; targets: unknown[] } =>
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === "hello",
    );
    expect(hellos).toHaveLength(3);
    expect(hellos.at(-1)?.targets).toEqual([]);
  });

  it("reports a durably ledgered allocation after the service worker restarts before the broker records its result", async () => {
    const harness = installStatefulChrome();
    const firstController =
      await import("../../extension/src/chrome-controller.js");
    const allocated = await firstController.handleChromeNativeCommand(
      command({ action: "target.allocate", visibility: "background" }),
    );
    expect(allocated).toMatchObject({
      ok: true,
      data: { tab_id: 11, owned: true, visibility: "background" },
    });

    vi.resetModules();
    await import("../../extension/src/background.js");

    await vi.waitFor(() =>
      expect(harness.nativeMessages).toContainEqual(
        expect.objectContaining({
          type: "hello",
          browser_session_id: BROWSER_SESSION_ID,
          targets: [
            expect.objectContaining({
              target_id: chromeTargetId(BROWSER_SESSION_ID, 11),
              tab_id: 11,
              owned: true,
              visibility: "background",
            }),
          ],
        }),
      ),
    );
  });

  it("retires a failed-cleanup allocation that never established a durable background guard", async () => {
    const harness = installStatefulChrome();
    const unchangedWindows = [{ id: 7, focused: true, type: "normal" }];
    harness.chrome.windows.getAll
      .mockResolvedValueOnce(structuredClone(unchangedWindows))
      .mockResolvedValueOnce(structuredClone(unchangedWindows))
      .mockResolvedValueOnce([
        ...structuredClone(unchangedWindows),
        { id: 8, focused: false, type: "normal" },
      ]);
    harness.chrome.tabs.remove.mockRejectedValueOnce(
      new Error("transient tab removal failure"),
    );
    const controller = await import("../../extension/src/chrome-controller.js");

    const failed = await controller.handleChromeNativeCommand(
      command({ action: "target.allocate", visibility: "background" }),
    );

    expect(failed).toMatchObject({
      ok: false,
      error: { code: "chrome_target_cleanup_failed" },
    });
    await expect(harness.chrome.tabs.get(11)).resolves.toMatchObject({
      url: "about:blank#unicli-allocation=request%3A1",
      active: false,
    });

    vi.resetModules();
    await import("../../extension/src/background.js");
    await vi.waitFor(() =>
      expect(harness.nativeMessages).toContainEqual(
        expect.objectContaining({
          type: "hello",
          targets: [],
        }),
      ),
    );
    await expect(harness.chrome.tabs.get(11)).rejects.toThrow(
      "No tab with id 11",
    );
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

  it("reattaches once for a read-only command after Chrome detaches the debugger", async () => {
    const harness = installStatefulChrome();
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const before = harness.uiState();
    const target = await claimBackgroundTarget(handleChromeNativeCommand, 10);
    harness.chrome.debugger.sendCommand
      .mockRejectedValueOnce(
        new Error("Debugger detached while handling command"),
      )
      .mockResolvedValueOnce({ nodes: [] });

    const snapshot = await handleChromeNativeCommand(
      command({
        action: "page.command",
        target_id: target.target_id,
        tab_id: target.tab_id,
        visibility: "background",
        command: { method: "snapshot" },
      }),
    );

    expect(snapshot).toMatchObject({ ok: true, data: { nodes: [] } });
    expect(harness.chrome.debugger.attach).toHaveBeenCalledTimes(2);
    expect(harness.chrome.debugger.sendCommand).toHaveBeenCalledTimes(2);
    expect(harness.uiState()).toEqual(before);
  });

  it("never replays an ambiguous debugger mutation after detach", async () => {
    const harness = installStatefulChrome();
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const target = await allocateOwnedBackgroundTarget(
      handleChromeNativeCommand,
    );
    let sideEffects = 0;
    harness.chrome.debugger.sendCommand.mockImplementationOnce(async () => {
      sideEffects += 1;
      throw new Error("Debugger detached after applying Runtime.evaluate");
    });

    const evaluated = await handleChromeNativeCommand(
      command({
        action: "page.command",
        target_id: target.target_id,
        tab_id: target.tab_id,
        visibility: "background",
        command: { method: "evaluate", expression: "window.charge()" },
      }),
    );

    expect(evaluated).toMatchObject({
      ok: false,
      error: { outcome_ambiguous: true },
    });
    expect(sideEffects).toBe(1);
    expect(harness.chrome.debugger.attach).toHaveBeenCalledTimes(1);
    expect(harness.chrome.debugger.sendCommand).toHaveBeenCalledTimes(1);
  });

  it("marks navigation completion timeout ambiguous after Chrome accepts the URL update", async () => {
    vi.useFakeTimers();
    try {
      const harness = installStatefulChrome();
      const { handleChromeNativeCommand } =
        await import("../../extension/src/chrome-controller.js");
      const target = await allocateOwnedBackgroundTarget(
        handleChromeNativeCommand,
      );
      harness.chrome.tabs.update.mockImplementationOnce(
        async (tabId: number, update: { url?: string }) =>
          harness.updateTabUrl(tabId, update.url ?? "about:blank"),
      );

      const pending = handleChromeNativeCommand(
        command({
          action: "page.command",
          target_id: target.target_id,
          tab_id: target.tab_id,
          visibility: "background",
          command: { method: "navigate", url: "https://after.test/" },
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.chrome.tabs.update).toHaveBeenCalledWith(target.tab_id, {
        url: "https://after.test/",
      });
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: {
          code: "chrome_navigation_timeout",
          retryable: false,
          outcome_ambiguous: true,
        },
      });
      await expect(
        harness.chrome.tabs.get(target.tab_id),
      ).resolves.toMatchObject({
        url: "https://after.test/",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores stale webNavigation completion until the committed document completes", async () => {
    const harness = installStatefulChrome();
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const target = await allocateOwnedBackgroundTarget(
      handleChromeNativeCommand,
    );
    harness.chrome.tabs.update.mockImplementationOnce(
      async (tabId: number, update: { url?: string }) =>
        harness.updateTabUrl(tabId, update.url ?? "about:blank"),
    );
    const url = "https://document-aware.test/";
    const pending = handleChromeNativeCommand(
      command({
        action: "page.command",
        target_id: target.target_id,
        tab_id: target.tab_id,
        visibility: "background",
        command: { method: "navigate", url },
      }),
    );
    await vi.waitFor(() =>
      expect(harness.chrome.tabs.update).toHaveBeenCalledWith(target.tab_id, {
        url,
      }),
    );
    const timeStamp = Date.now();
    harness.webNavigationOnCompleted.emit({
      documentLifecycle: "active",
      documentId: "document:stale",
      frameId: 0,
      frameType: "outermost_frame",
      parentFrameId: -1,
      processId: 1,
      tabId: target.tab_id,
      timeStamp,
      url,
    });
    harness.webNavigationOnBeforeNavigate.emit({
      documentLifecycle: "active",
      frameId: 0,
      frameType: "outermost_frame",
      parentFrameId: -1,
      processId: 1,
      tabId: target.tab_id,
      timeStamp,
      url,
    });
    harness.webNavigationOnCommitted.emit({
      documentLifecycle: "active",
      documentId: "document:new",
      frameId: 0,
      frameType: "outermost_frame",
      parentFrameId: -1,
      processId: 1,
      tabId: target.tab_id,
      timeStamp,
      transitionQualifiers: [],
      transitionType: "link",
      url,
    });
    harness.webNavigationOnCompleted.emit({
      documentLifecycle: "active",
      documentId: "document:stale",
      frameId: 0,
      frameType: "outermost_frame",
      parentFrameId: -1,
      processId: 1,
      tabId: target.tab_id,
      timeStamp,
      url,
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    harness.webNavigationOnCompleted.emit({
      documentLifecycle: "active",
      documentId: "document:new",
      frameId: 0,
      frameType: "outermost_frame",
      parentFrameId: -1,
      processId: 1,
      tabId: target.tab_id,
      timeStamp,
      url,
    });
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it("propagates lost acknowledgement for an applied dialog response as ambiguous", async () => {
    const harness = installStatefulChrome();
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const target = await allocateOwnedBackgroundTarget(
      handleChromeNativeCommand,
    );
    await handleChromeNativeCommand(
      command({
        action: "page.command",
        target_id: target.target_id,
        tab_id: target.tab_id,
        visibility: "background",
        command: { method: "dialog_read" },
      }),
    );
    harness.debuggerOnEvent.emit(
      { tabId: target.tab_id },
      "Page.javascriptDialogOpening",
      { type: "confirm", message: "Proceed?" },
    );
    let responseApplied = false;
    harness.chrome.debugger.sendCommand.mockImplementation(
      async (_target: unknown, method: string) => {
        if (method === "Page.handleJavaScriptDialog") {
          responseApplied = true;
          throw new Error(
            "Debugger detached after applying Page.handleJavaScriptDialog",
          );
        }
        return {};
      },
    );

    const result = await handleChromeNativeCommand(
      command({
        action: "page.command",
        target_id: target.target_id,
        tab_id: target.tab_id,
        visibility: "background",
        command: {
          method: "dialog_respond",
          action: "accept",
          dialog_id: "d-1",
        },
      }),
    );

    expect(responseApplied).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "chrome_command_failed",
        retryable: false,
        outcome_ambiguous: true,
      },
    });
    expect(
      harness.chrome.debugger.sendCommand.mock.calls.filter(
        ([, method]) => method === "Page.handleJavaScriptDialog",
      ),
    ).toHaveLength(1);
  });

  it("replays idempotent Network.enable once after debugger detach", async () => {
    const harness = installStatefulChrome();
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const target = await claimBackgroundTarget(handleChromeNativeCommand, 10);
    let enableAttempts = 0;
    harness.chrome.debugger.sendCommand.mockImplementation(
      async (_target: unknown, method: string) => {
        if (method === "Network.enable" && ++enableAttempts === 1) {
          throw new Error("Debugger detached after applying Network.enable");
        }
        return {};
      },
    );

    const result = await handleChromeNativeCommand(
      command({
        action: "page.command",
        target_id: target.target_id,
        tab_id: target.tab_id,
        visibility: "background",
        command: { method: "network_capture_start" },
      }),
    );

    expect(result).toMatchObject({ ok: true, data: true });
    expect(enableAttempts).toBe(2);
    expect(harness.chrome.debugger.attach).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      pageCommand: { method: "native_click", x: 20, y: 30 } as const,
      down: "mousePressed",
      up: "mouseReleased",
    },
    {
      pageCommand: { method: "press", key: "Enter" } as const,
      down: "keyDown",
      up: "keyUp",
    },
  ])(
    "retries only the compensating $up after debugger detach",
    async ({ pageCommand, down, up }) => {
      const harness = installStatefulChrome();
      const { handleChromeNativeCommand } =
        await import("../../extension/src/chrome-controller.js");
      const target = await allocateOwnedBackgroundTarget(
        handleChromeNativeCommand,
      );
      const inputEvents: string[] = [];
      let releaseAttempts = 0;
      harness.chrome.debugger.sendCommand.mockImplementation(
        async (_target: unknown, _method: string, params: unknown) => {
          const type = String(
            (params as Record<string, unknown> | undefined)?.type ?? "",
          );
          inputEvents.push(type);
          if (type === up) {
            releaseAttempts += 1;
            if (releaseAttempts === 1) {
              throw new Error(`Debugger detached before applying ${up}`);
            }
          }
          return {};
        },
      );

      const result = await handleChromeNativeCommand(
        command({
          action: "page.command",
          target_id: target.target_id,
          tab_id: target.tab_id,
          visibility: "background",
          command: pageCommand,
        }),
      );

      expect(result).toMatchObject({ ok: true });
      expect(inputEvents).toEqual([down, up, up]);
      expect(harness.chrome.debugger.attach).toHaveBeenCalledTimes(2);
    },
  );

  it("always dispatches release after an ambiguously applied input down without replaying down", async () => {
    const harness = installStatefulChrome();
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const target = await allocateOwnedBackgroundTarget(
      handleChromeNativeCommand,
    );
    const inputEvents: string[] = [];
    harness.chrome.debugger.sendCommand.mockImplementation(
      async (_target: unknown, _method: string, params: unknown) => {
        const type = String(
          (params as Record<string, unknown> | undefined)?.type ?? "",
        );
        inputEvents.push(type);
        if (type === "mousePressed") {
          throw new Error("Debugger detached after applying mousePressed");
        }
        return {};
      },
    );

    const result = await handleChromeNativeCommand(
      command({
        action: "page.command",
        target_id: target.target_id,
        tab_id: target.tab_id,
        visibility: "background",
        command: { method: "native_click", x: 20, y: 30 },
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { retryable: false, outcome_ambiguous: true },
    });
    expect(inputEvents).toEqual(["mousePressed", "mouseReleased"]);
    expect(harness.chrome.debugger.attach).toHaveBeenCalledTimes(2);
  });

  it.each([
    { popupWindowType: "normal" as const, focused: true },
    { popupWindowType: "popup" as const, focused: false },
  ])(
    "closes a command-created $popupWindowType popup and restores attributable Chrome UI state",
    async ({ popupWindowType, focused }) => {
      const harness = installStatefulChrome({
        tabs: taskAndUserTabs(),
      });
      const { handleChromeNativeCommand } =
        await import("../../extension/src/chrome-controller.js");
      const target = await allocateOwnedBackgroundTarget(
        handleChromeNativeCommand,
      );
      const before = harness.uiState();
      let popupTabId: number | null = null;
      installPopupOpeningClick(harness, () => {
        popupTabId = harness.openTab({
          newWindowType: popupWindowType,
          focused,
          active: true,
          openerTabId: target.tab_id,
          url: "https://popup.test/",
        }).id;
      });

      const result = await handleChromeNativeCommand(
        backgroundClickCommand(target.tab_id),
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "background_postcondition_failed",
          retryable: false,
          outcome_ambiguous: true,
        },
      });
      expect(popupTabId).not.toBeNull();
      await expect(harness.chrome.tabs.get(popupTabId!)).rejects.toThrow(
        "No tab with id",
      );
      await expect(harness.chrome.tabs.get(10)).resolves.toMatchObject({
        url: "https://user.test/",
      });
      expect(harness.uiState()).toEqual(before);
    },
  );

  it("closes same-window and transitive opener descendants child-first", async () => {
    const harness = installStatefulChrome({ tabs: taskAndUserTabs() });
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const target = await allocateOwnedBackgroundTarget(
      handleChromeNativeCommand,
    );
    const before = harness.uiState();
    const popupTabIds: number[] = [];
    installPopupOpeningClick(harness, () => {
      const parent = harness.openTab({
        windowId: 7,
        active: true,
        openerTabId: target.tab_id,
        url: "https://popup.test/parent",
      });
      const child = harness.openTab({
        newWindowType: "popup",
        focused: true,
        active: true,
        openerTabId: parent.id,
        url: "https://popup.test/child",
      });
      popupTabIds.push(parent.id, child.id);
    });

    const result = await handleChromeNativeCommand(
      backgroundClickCommand(target.tab_id),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "background_postcondition_failed",
        outcome_ambiguous: true,
      },
    });
    for (const popupTabId of popupTabIds) {
      await expect(harness.chrome.tabs.get(popupTabId)).rejects.toThrow(
        "No tab with id",
      );
    }
    expect(harness.removedTabIds).toEqual([popupTabIds[1], popupTabIds[0]]);
    expect(harness.uiState()).toEqual(before);
  });

  it("compensates a popup when the page command itself fails and preserves that command error", async () => {
    const harness = installStatefulChrome({ tabs: taskAndUserTabs() });
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const target = await allocateOwnedBackgroundTarget(
      handleChromeNativeCommand,
    );
    const before = harness.uiState();
    let popupTabId: number | null = null;
    installPopupOpeningClick(harness, () => {
      popupTabId = harness.openTab({
        newWindowType: "popup",
        focused: true,
        active: true,
        openerTabId: target.tab_id,
        url: "https://popup.test/error",
      }).id;
      throw new Error("Injected deterministic click failure");
    });

    const result = await handleChromeNativeCommand(
      backgroundClickCommand(target.tab_id),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "chrome_command_failed",
        message: "Injected deterministic click failure",
      },
    });
    await expect(harness.chrome.tabs.get(popupTabId!)).rejects.toThrow(
      "No tab with id",
    );
    expect(harness.uiState()).toEqual(before);
  });

  it("removes only attributable popups without clobbering a concurrent user tab or focus", async () => {
    const harness = installStatefulChrome({ tabs: taskAndUserTabs() });
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const target = await allocateOwnedBackgroundTarget(
      handleChromeNativeCommand,
    );
    let popupTabId: number | null = null;
    let userTabId: number | null = null;
    installPopupOpeningClick(harness, () => {
      popupTabId = harness.openTab({
        newWindowType: "popup",
        focused: true,
        active: true,
        openerTabId: target.tab_id,
        url: "https://popup.test/",
      }).id;
      userTabId = harness.openTab({
        newWindowType: "normal",
        focused: true,
        active: true,
        url: "https://user-concurrent.test/",
      }).id;
    });

    const result = await handleChromeNativeCommand(
      backgroundClickCommand(target.tab_id),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "background_postcondition_failed",
        outcome_ambiguous: true,
      },
    });
    await expect(harness.chrome.tabs.get(popupTabId!)).rejects.toThrow(
      "No tab with id",
    );
    await expect(harness.chrome.tabs.get(userTabId!)).resolves.toMatchObject({
      active: true,
      url: "https://user-concurrent.test/",
    });
    expect(harness.uiState().focused_window_id).toBe(9);
    expect(harness.chrome.tabs.update).not.toHaveBeenCalledWith(10, {
      active: true,
    });
    expect(harness.chrome.windows.update).not.toHaveBeenCalledWith(7, {
      focused: true,
    });
  });

  it("supervises delayed opener descendants after command success and poisons only the offending target", async () => {
    const harness = installStatefulChrome({ tabs: taskAndUserTabs() });
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const target = await allocateOwnedBackgroundTarget(
      handleChromeNativeCommand,
    );
    let popupTabId: number | null = null;
    let popupScheduled = false;
    harness.chrome.debugger.sendCommand.mockImplementation(
      async (_target: unknown, method: string) => {
        if (method === "Runtime.evaluate" && !popupScheduled) {
          popupScheduled = true;
          setTimeout(() => {
            popupTabId = harness.openTab({
              newWindowType: "popup",
              focused: true,
              active: true,
              openerTabId: target.tab_id,
              url: "https://popup-delayed.test/",
            }).id;
          }, 50);
          return { result: { value: "scheduled" } };
        }
        return { result: { value: "Task" } };
      },
    );

    const first = await handleChromeNativeCommand(
      command({
        action: "page.command",
        target_id: target.target_id,
        tab_id: target.tab_id,
        visibility: "background",
        command: { method: "evaluate", expression: "schedule popup" },
      }),
    );
    expect(first).toMatchObject({ ok: true, data: "scheduled" });

    const userTab = harness.openTab({
      newWindowType: "normal",
      focused: true,
      active: true,
      url: "https://user-after-command.test/",
    });
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(popupTabId).not.toBeNull();
    await expect(harness.chrome.tabs.get(popupTabId!)).rejects.toThrow(
      "No tab with id",
    );
    await expect(harness.chrome.tabs.get(userTab.id)).resolves.toMatchObject({
      active: true,
      url: "https://user-after-command.test/",
    });
    expect(harness.uiState().focused_window_id).toBe(userTab.windowId);

    const next = await handleChromeNativeCommand(
      command({
        action: "page.command",
        target_id: target.target_id,
        tab_id: target.tab_id,
        visibility: "background",
        command: { method: "title" },
      }),
    );
    expect(next).toMatchObject({
      ok: false,
      error: {
        code: "background_postcondition_failed",
        retryable: false,
        target_unusable: true,
      },
    });
    await expect(harness.chrome.tabs.get(userTab.id)).resolves.toMatchObject({
      active: true,
    });
  });

  it("restores a background target that becomes active without opening a popup", async () => {
    const harness = installStatefulChrome({ tabs: taskAndUserTabs() });
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const target = await allocateOwnedBackgroundTarget(
      handleChromeNativeCommand,
    );
    const before = harness.uiState();
    installPopupOpeningClick(harness, () => harness.activateTab(target.tab_id));

    const result = await handleChromeNativeCommand(
      backgroundClickCommand(target.tab_id),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "background_postcondition_failed",
        outcome_ambiguous: true,
      },
    });
    expect(harness.uiState()).toEqual(before);
    expect(harness.chrome.tabs.update).toHaveBeenCalledWith(10, {
      active: true,
    });
  });

  it("restores an attributable same-window popup in an unfocused task window", async () => {
    const harness = installStatefulChrome({
      windows: [
        { id: 7, focused: false, type: "normal" },
        { id: 8, focused: true, type: "normal" },
      ],
      tabs: [
        {
          id: 10,
          windowId: 7,
          active: true,
          url: "https://user.test/",
          title: "User",
        },
        {
          id: 11,
          windowId: 8,
          active: true,
          url: "https://task.test/",
          title: "Task",
        },
      ],
    });
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const target = await allocateOwnedBackgroundTarget(
      handleChromeNativeCommand,
    );
    harness.focusWindow(7);
    const before = harness.uiState();
    installPopupOpeningClick(harness, () => {
      harness.openTab({
        windowId: 8,
        focused: true,
        active: true,
        openerTabId: target.tab_id,
        url: "https://popup.test/",
      });
    });

    const result = await handleChromeNativeCommand(
      backgroundClickCommand(target.tab_id),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "background_postcondition_failed",
        outcome_ambiguous: true,
      },
    });
    expect(harness.uiState()).toEqual(before);
    expect(harness.chrome.windows.update).toHaveBeenCalledWith(7, {
      focused: true,
    });
  });

  it("preserves a user tab activated while popup cleanup is in flight", async () => {
    const harness = installStatefulChrome({
      tabs: [
        ...taskAndUserTabs(),
        {
          id: 15,
          windowId: 7,
          active: false,
          url: "https://user-other.test/",
          title: "User Other",
        },
      ],
    });
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const target = await allocateOwnedBackgroundTarget(
      handleChromeNativeCommand,
    );
    installPopupOpeningClick(harness, () => {
      harness.openTab({
        windowId: 7,
        active: true,
        openerTabId: target.tab_id,
        url: "https://popup.test/",
      });
    });
    harness.beforeRemoveTab(() => harness.activateTab(15));

    const result = await handleChromeNativeCommand(
      backgroundClickCommand(target.tab_id),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "background_postcondition_failed",
        outcome_ambiguous: true,
      },
    });
    await expect(harness.chrome.tabs.get(15)).resolves.toMatchObject({
      active: true,
    });
    expect(harness.chrome.tabs.update).not.toHaveBeenCalledWith(10, {
      active: true,
    });
  });

  it("rejects background mutation on a claimed tab and still releases it", async () => {
    const harness = installStatefulChrome();
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const target = await claimBackgroundTarget(handleChromeNativeCommand, 10);

    const mutation = await handleChromeNativeCommand(
      command({
        action: "page.command",
        target_id: target.target_id,
        tab_id: target.tab_id,
        visibility: "background",
        command: { method: "evaluate", expression: "window.mutate()" },
      }),
    );

    expect(mutation).toMatchObject({
      ok: false,
      error: {
        code: "background_mutation_requires_foreground",
        retryable: false,
      },
    });
    expect(harness.chrome.debugger.sendCommand).not.toHaveBeenCalled();
    await expect(
      handleChromeNativeCommand(
        command({
          action: "target.finalize",
          target_id: target.target_id,
          tab_id: target.tab_id,
          visibility: "background",
          disposition: "release",
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(harness.chrome.tabs.get(10)).resolves.toMatchObject({
      url: "https://example.com/",
    });
  });

  it("rejects release after owned background mutation but permits an explicit close", async () => {
    const harness = installStatefulChrome();
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const target = await allocateOwnedBackgroundTarget(
      handleChromeNativeCommand,
    );
    await expect(
      handleChromeNativeCommand(
        command({
          action: "page.command",
          target_id: target.target_id,
          tab_id: target.tab_id,
          visibility: "background",
          command: { method: "evaluate", expression: "document.title" },
        }),
      ),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      handleChromeNativeCommand(
        command({
          action: "target.finalize",
          target_id: target.target_id,
          tab_id: target.tab_id,
          visibility: "background",
          disposition: "release",
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "background_release_unsafe" },
    });
    await expect(
      handleChromeNativeCommand(
        command({
          action: "target.finalize",
          target_id: target.target_id,
          tab_id: target.tab_id,
          visibility: "background",
          disposition: "close",
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(harness.chrome.tabs.get(target.tab_id)).rejects.toThrow(
      "No tab with id",
    );
  });

  it("compensates delayed root activation and poisons only that target", async () => {
    const harness = installStatefulChrome();
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const target = await allocateOwnedBackgroundTarget(
      handleChromeNativeCommand,
    );
    const before = harness.uiState();
    await handleChromeNativeCommand(
      command({
        action: "page.command",
        target_id: target.target_id,
        tab_id: target.tab_id,
        visibility: "background",
        command: { method: "evaluate", expression: "document.title" },
      }),
    );

    harness.activateTab(target.tab_id);
    await vi.waitFor(() => expect(harness.uiState()).toEqual(before));
    await expect(
      handleChromeNativeCommand(
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
      error: {
        code: "background_postcondition_failed",
        target_unusable: true,
      },
    });
  });

  it("attributes noopener navigation after onCreated without poisoning its safe baseline", async () => {
    const harness = installStatefulChrome();
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const target = await allocateOwnedBackgroundTarget(
      handleChromeNativeCommand,
    );
    await handleChromeNativeCommand(
      command({
        action: "page.command",
        target_id: target.target_id,
        tab_id: target.tab_id,
        visibility: "background",
        command: { method: "evaluate", expression: "document.title" },
      }),
    );
    const userTab = harness.openTab({
      newWindowType: "normal",
      focused: true,
      active: true,
      url: "https://user-latest.test/",
    });
    await vi.waitFor(() =>
      expect(
        readSeededGuardSafeState(harness.sessionStorageState())
          ?.focused_window_id,
      ).toBe(userTab.windowId),
    );
    const popup = harness.openTab({
      newWindowType: "popup",
      focused: true,
      active: true,
      complete: false,
      url: "https://noopener-popup.test/",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    harness.emitNavigationTarget(target.tab_id, popup.id);

    await vi.waitFor(async () =>
      expect(harness.chrome.tabs.get(popup.id)).rejects.toThrow(
        "No tab with id",
      ),
    );
    await expect(harness.chrome.tabs.get(userTab.id)).resolves.toMatchObject({
      active: true,
    });
    expect(harness.uiState().focused_window_id).toBe(userTab.windowId);
    await expect(
      handleChromeNativeCommand(
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
      error: { target_unusable: true },
    });
  });

  it("restores a loading user tab focused before a later attributable popup", async () => {
    const harness = installStatefulChrome();
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const target = await allocateOwnedBackgroundTarget(
      handleChromeNativeCommand,
    );
    let userTabId = -1;
    let userWindowId = -1;
    let popupTabId = -1;
    installPopupOpeningClick(harness, () => {
      const userTab = harness.openTab({
        newWindowType: "normal",
        focused: true,
        active: true,
        complete: false,
        url: "https://user-loading.test/",
      });
      userTabId = userTab.id;
      userWindowId = userTab.windowId;
      popupTabId = harness.openTab({
        windowId: 7,
        focused: true,
        active: true,
        openerTabId: target.tab_id,
        url: "https://late-popup.test/",
      }).id;
    });

    await expect(
      handleChromeNativeCommand(backgroundClickCommand(target.tab_id)),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "background_postcondition_failed" },
    });

    await expect(harness.chrome.tabs.get(popupTabId)).rejects.toThrow(
      "No tab with id",
    );
    await expect(harness.chrome.tabs.get(userTabId)).resolves.toMatchObject({
      active: true,
    });
    expect(harness.uiState().focused_window_id).toBe(userWindowId);
  });

  it("retires a non-quiescent popup source within a bounded supervisor turn", async () => {
    const harness = installStatefulChrome();
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const target = await allocateOwnedBackgroundTarget(
      handleChromeNativeCommand,
    );
    let injectionCount = 0;
    const injectPopup = (): void => {
      injectionCount += 1;
      harness.openTab({
        windowId: 7,
        active: true,
        openerTabId: target.tab_id,
        url: `https://continuous-popup.test/${String(injectionCount)}`,
      });
    };
    installPopupOpeningClick(harness, injectPopup);
    harness.beforeEveryRemoveTab(() => {
      if (harness.tabsState().some((tab) => tab.id === target.tab_id)) {
        injectPopup();
      }
    });

    await expect(
      Promise.race([
        handleChromeNativeCommand(backgroundClickCommand(target.tab_id)),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("supervisor turn stalled")), 500),
        ),
      ]),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "background_supervisor_budget_exceeded",
        target_unusable: true,
      },
    });
    expect(injectionCount).toBeGreaterThan(8);
    await expect(harness.chrome.tabs.get(target.tab_id)).rejects.toThrow(
      "No tab with id",
    );
    expect(
      harness
        .tabsState()
        .filter((tab) => tab.url.startsWith("https://continuous-popup.test/")),
    ).toEqual([]);
    expect(harness.uiState()).toMatchObject({
      focused_window_id: 7,
      active_tabs: [{ window_id: 7, tab_id: 10 }],
    });

    await expect(
      allocateOwnedBackgroundTarget(handleChromeNativeCommand),
    ).resolves.toMatchObject({ owned: true, visibility: "background" });
  });

  it("cancels a hung Chrome command and retires its root before returning", async () => {
    const harness = installStatefulChrome();
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const target = await allocateOwnedBackgroundTarget(
      handleChromeNativeCommand,
    );
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const never = new Promise<never>(() => undefined);
    harness.chrome.debugger.sendCommand.mockImplementation(
      async (_target: unknown, method: string) => {
        if (method === "DOM.getDocument") {
          markStarted();
          return never;
        }
        return {};
      },
    );
    const cancellation = new AbortController();
    const commandOutcome = handleChromeNativeCommand(
      backgroundClickCommand(target.tab_id),
      cancellation.signal,
    );
    await started;
    cancellation.abort(new DOMException("test cancellation", "AbortError"));

    await expect(
      Promise.race([
        commandOutcome,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("cancelled command stalled")), 500),
        ),
      ]),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "chrome_command_failed",
        outcome_ambiguous: true,
        target_unusable: true,
      },
    });
    await expect(harness.chrome.tabs.get(target.tab_id)).rejects.toThrow(
      "No tab with id",
    );
    expect(harness.targetLedger()).toEqual({ version: 1, entries: [] });
  });

  it("contains a popup created from a retired root after cancellation returns", async () => {
    const harness = installStatefulChrome();
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const target = await allocateOwnedBackgroundTarget(
      handleChromeNativeCommand,
    );
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const never = new Promise<never>(() => undefined);
    harness.chrome.debugger.sendCommand.mockImplementation(
      async (_target: unknown, method: string) => {
        if (method === "DOM.getDocument") {
          markStarted();
          return never;
        }
        return {};
      },
    );
    const cancellation = new AbortController();
    const commandOutcome = handleChromeNativeCommand(
      backgroundClickCommand(target.tab_id),
      cancellation.signal,
    );
    await started;
    cancellation.abort(new DOMException("test cancellation", "AbortError"));
    await commandOutcome;

    const popup = harness.openTab({
      newWindowType: "popup",
      focused: true,
      active: true,
      openerTabId: target.tab_id,
      url: "https://post-cancel-popup.test/",
    });

    await vi.waitFor(async () =>
      expect(harness.chrome.tabs.get(popup.id)).rejects.toThrow(
        "No tab with id",
      ),
    );
    expect(harness.uiState()).toEqual({
      window_ids: [7],
      focused_window_id: 7,
      active_tabs: [{ window_id: 7, tab_id: 10 }],
    });
    expect(
      harness.sessionStorageState().unicli_retired_background_lineages_v1,
    ).toEqual([
      expect.objectContaining({
        root_tab_id: target.tab_id,
        lineage_tab_ids: expect.arrayContaining([target.tab_id, popup.id]),
      }),
    ]);
  });

  it("preserves user focus changes made after root retirement", async () => {
    const harness = installStatefulChrome({
      windows: [
        { id: 7, focused: true, type: "normal" },
        { id: 8, focused: false, type: "normal" },
      ],
      tabs: [
        seededTab(10, true, "https://first-user.test/"),
        {
          ...seededTab(20, true, "https://second-user.test/"),
          windowId: 8,
        },
      ],
    });
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const target = await allocateOwnedBackgroundTarget(
      handleChromeNativeCommand,
    );
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const never = new Promise<never>(() => undefined);
    harness.chrome.debugger.sendCommand.mockImplementation(
      async (_target: unknown, method: string) => {
        if (method === "DOM.getDocument") {
          markStarted();
          return never;
        }
        return {};
      },
    );
    const cancellation = new AbortController();
    const commandOutcome = handleChromeNativeCommand(
      backgroundClickCommand(target.tab_id),
      cancellation.signal,
    );
    await started;
    cancellation.abort(new DOMException("test cancellation", "AbortError"));
    await commandOutcome;

    harness.activateTab(20);
    harness.focusWindow(8);
    const popup = harness.openTab({
      newWindowType: "popup",
      focused: true,
      active: true,
      openerTabId: target.tab_id,
      url: "https://post-focus-popup.test/",
    });

    await vi.waitFor(async () =>
      expect(harness.chrome.tabs.get(popup.id)).rejects.toThrow(
        "No tab with id",
      ),
    );
    await expect(harness.chrome.tabs.get(20)).resolves.toMatchObject({
      active: true,
    });
    expect(harness.uiState().focused_window_id).toBe(8);
  });

  it("hydrates retired lineage supervision before containing a late popup", async () => {
    const expiresAt = Date.now() + CHROME_NATIVE_COMMAND_DEADLINE_MS;
    const harness = installStatefulChrome({
      sessionStorage: {
        unicli_retired_background_lineages_v1: [
          {
            root_tab_id: 42,
            safe_state: {
              window_ids: [7],
              focused_window_id: 7,
              active_tabs: [{ window_id: 7, tab_id: 10 }],
            },
            lineage_tab_ids: [42],
            expires_at: expiresAt,
          },
        ],
      },
    });
    await import("../../extension/src/background.js");
    await vi.waitFor(() =>
      expect(harness.nativeMessages).toContainEqual(
        expect.objectContaining({ type: "hello", targets: [] }),
      ),
    );

    const popup = harness.openTab({
      newWindowType: "popup",
      focused: true,
      active: true,
      openerTabId: 42,
      url: "https://post-restart-popup.test/",
    });

    await vi.waitFor(async () =>
      expect(harness.chrome.tabs.get(popup.id)).rejects.toThrow(
        "No tab with id",
      ),
    );
    expect(harness.uiState()).toEqual({
      window_ids: [7],
      focused_window_id: 7,
      active_tabs: [{ window_id: 7, tab_id: 10 }],
    });
  });

  it("invalidates a foreground target when its dispatched Chrome command is cancelled", async () => {
    const harness = installStatefulChrome();
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const allocation = await handleChromeNativeCommand(
      command({ action: "target.allocate", visibility: "foreground" }),
    );
    if (!allocation.ok) throw new Error(allocation.error.message);
    const target = allocation.data as ChromeNativeTarget;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let finishLate!: () => void;
    const lateCompletion = new Promise<Record<string, unknown>>((resolve) => {
      finishLate = () => resolve({ result: { value: "late" } });
    });
    harness.chrome.debugger.sendCommand.mockImplementation(
      async (_target: unknown, method: string) => {
        if (method === "Runtime.evaluate") {
          markStarted();
          return lateCompletion;
        }
        return {};
      },
    );
    const cancellation = new AbortController();
    const outcome = handleChromeNativeCommand(
      command({
        action: "page.command",
        target_id: target.target_id,
        tab_id: target.tab_id,
        visibility: "foreground",
        command: { method: "evaluate", expression: "window.sideEffect()" },
      }),
      cancellation.signal,
    );
    await started;
    cancellation.abort(new DOMException("test cancellation", "AbortError"));

    await expect(
      Promise.race([
        outcome,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("foreground cancel stalled")), 500),
        ),
      ]),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "chrome_command_cancelled",
        outcome_ambiguous: true,
        target_unusable: true,
      },
    });
    await expect(harness.chrome.tabs.get(target.tab_id)).rejects.toThrow(
      "No tab with id",
    );
    expect(harness.targetLedger()).toEqual({ version: 1, entries: [] });
    finishLate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(harness.chrome.tabs.get(target.tab_id)).rejects.toThrow(
      "No tab with id",
    );
    expect(harness.targetLedger()).toEqual({ version: 1, entries: [] });
  });

  it("drains descendants created while command compensation is awaiting Chrome", async () => {
    const harness = installStatefulChrome();
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const target = await allocateOwnedBackgroundTarget(
      handleChromeNativeCommand,
    );
    const before = harness.uiState();
    let firstPopupId = -1;
    let secondPopupId = -1;
    installPopupOpeningClick(harness, () => {
      firstPopupId = harness.openTab({
        windowId: 7,
        active: true,
        openerTabId: target.tab_id,
        url: "https://popup.test/first",
      }).id;
    });
    harness.beforeRemoveTab(() => {
      secondPopupId = harness.openTab({
        windowId: 7,
        active: true,
        openerTabId: target.tab_id,
        url: "https://popup.test/during-compensation",
      }).id;
    });

    const result = await handleChromeNativeCommand(
      backgroundClickCommand(target.tab_id),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "background_postcondition_failed" },
    });
    await expect(harness.chrome.tabs.get(firstPopupId)).rejects.toThrow(
      "No tab with id",
    );
    await expect(harness.chrome.tabs.get(secondPopupId)).rejects.toThrow(
      "No tab with id",
    );
    expect(harness.uiState()).toEqual(before);
  });

  it("keeps the supervision queue live after a root tab removal", async () => {
    const harness = installStatefulChrome();
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const first = await allocateOwnedBackgroundTarget(
      handleChromeNativeCommand,
    );
    await harness.chrome.tabs.remove(first.tab_id);

    const second = await Promise.race([
      allocateOwnedBackgroundTarget(handleChromeNativeCommand),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("supervisor queue stalled")), 500),
      ),
    ]);

    expect(second.tab_id).not.toBe(first.tab_id);
  });

  it("drops a fast-closed navigation target without globally poisoning supervision", async () => {
    const harness = installStatefulChrome();
    const { handleChromeNativeCommand } =
      await import("../../extension/src/chrome-controller.js");
    const target = await allocateOwnedBackgroundTarget(
      handleChromeNativeCommand,
    );
    await handleChromeNativeCommand(
      command({
        action: "page.command",
        target_id: target.target_id,
        tab_id: target.tab_id,
        visibility: "background",
        command: { method: "evaluate", expression: "document.title" },
      }),
    );
    const popup = harness.openTab({
      windowId: 7,
      active: true,
      complete: false,
      url: "https://fast-popup.test/",
    });
    await harness.chrome.tabs.remove(popup.id);

    harness.emitNavigationTarget(target.tab_id, popup.id);

    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      handleChromeNativeCommand(
        command({
          action: "page.command",
          target_id: target.target_id,
          tab_id: target.tab_id,
          visibility: "background",
          command: { method: "title" },
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
  });

  it("retires active owned background state before the restart hello", async () => {
    const target = seededTarget(11, true);
    const harness = installStatefulChrome({
      tabs: [
        seededTab(10, false, "https://user.test/"),
        seededTab(11, true, "https://task.test/"),
      ],
      sessionStorage: seededRuntimeStorage([target], [seededGuard(target)]),
    });

    await import("../../extension/src/background.js");

    await vi.waitFor(() =>
      expect(harness.nativeMessages).toContainEqual(
        expect.objectContaining({ type: "hello", targets: [] }),
      ),
    );
    await expect(harness.chrome.tabs.get(11)).rejects.toThrow("No tab with id");
    await expect(harness.chrome.tabs.get(10)).resolves.toMatchObject({
      active: true,
    });
  });

  it("retires owned and releases claimed targets that restart without guards", async () => {
    const claimed = seededTarget(10, false);
    const owned = seededTarget(11, true);
    const harness = installStatefulChrome({
      tabs: [
        seededTab(10, true, "https://user.test/"),
        seededTab(11, false, "https://task.test/"),
      ],
      sessionStorage: seededRuntimeStorage([claimed, owned], []),
    });

    await import("../../extension/src/background.js");

    await vi.waitFor(() =>
      expect(harness.nativeMessages).toContainEqual(
        expect.objectContaining({ type: "hello", targets: [] }),
      ),
    );
    await expect(harness.chrome.tabs.get(10)).resolves.toMatchObject({
      url: "https://user.test/",
    });
    await expect(harness.chrome.tabs.get(11)).rejects.toThrow("No tab with id");
  });

  it("replays a cold-wake navigation event only after durable guard hydration", async () => {
    let releaseStorage: (() => void) | undefined;
    const storageGetGate = new Promise<void>((resolve) => {
      releaseStorage = resolve;
    });
    const target = seededTarget(11, true);
    const harness = installStatefulChrome({
      windows: [
        { id: 7, focused: false, type: "normal" },
        { id: 8, focused: true, type: "popup" },
      ],
      tabs: [
        seededTab(10, true, "https://user.test/"),
        seededTab(11, false, "https://task.test/"),
        {
          ...seededTab(12, true, "https://popup.test/"),
          windowId: 8,
        },
      ],
      sessionStorage: seededRuntimeStorage([target], [seededGuard(target)]),
      storageGetGate,
    });
    await import("../../extension/src/background.js");
    await vi.waitFor(() =>
      expect(harness.chrome.storage.session.get).toHaveBeenCalled(),
    );

    harness.emitNavigationTarget(target.tab_id, 12);
    releaseStorage?.();

    await vi.waitFor(() =>
      expect(harness.nativeMessages).toContainEqual(
        expect.objectContaining({ type: "hello", targets: [] }),
      ),
    );
    await expect(harness.chrome.tabs.get(12)).rejects.toThrow("No tab with id");
    await expect(harness.chrome.tabs.get(11)).rejects.toThrow("No tab with id");
    await expect(harness.chrome.tabs.get(10)).resolves.toMatchObject({
      active: true,
    });
    expect(harness.uiState().focused_window_id).toBe(7);
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

type ChromeCommandHandler = (
  command: ChromeNativeCommand,
  signal?: AbortSignal,
) => Promise<ChromeNativeResult>;

async function allocateOwnedBackgroundTarget(
  handle: ChromeCommandHandler,
): Promise<ChromeNativeTarget> {
  const result = await handle(
    command({ action: "target.allocate", visibility: "background" }),
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.data as ChromeNativeTarget;
}

async function claimBackgroundTarget(
  handle: ChromeCommandHandler,
  tabId: number,
): Promise<ChromeNativeTarget> {
  const result = await handle(
    command({
      action: "target.claim",
      tab_id: tabId,
      visibility: "background",
    }),
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.data as ChromeNativeTarget;
}

function backgroundClickCommand(tabId: number): ChromeNativeCommand {
  return command({
    action: "page.command",
    target_id: chromeTargetId(BROWSER_SESSION_ID, tabId),
    tab_id: tabId,
    visibility: "background",
    command: { method: "click", selector: "#opens-popup" },
  });
}

function taskAndUserTabs(): TabState[] {
  return [
    {
      id: 10,
      windowId: 7,
      active: true,
      url: "https://user.test/",
      title: "User",
      lastAccessed: 100,
    },
    {
      id: 11,
      windowId: 7,
      active: false,
      url: "https://task.test/",
      title: "Task",
      lastAccessed: 99,
    },
  ];
}

function seededTab(id: number, active: boolean, url: string): TabState {
  return {
    id,
    windowId: 7,
    active,
    url,
    title: url,
    lastAccessed: 100 - id,
  };
}

function seededTarget(tabId: number, owned: boolean): ChromeNativeTarget {
  return {
    target_id: chromeTargetId(BROWSER_SESSION_ID, tabId),
    tab_id: tabId,
    window_id: 7,
    owned,
    visibility: "background",
    url: owned ? "https://task.test/" : "https://user.test/",
  };
}

function seededGuard(target: ChromeNativeTarget): Record<string, unknown> {
  return {
    target_id: target.target_id,
    tab_id: target.tab_id,
    owned: target.owned,
    safe_state: {
      window_ids: [7],
      focused_window_id: 7,
      active_tabs: [{ window_id: 7, tab_id: 10 }],
    },
    page_mutated: true,
    descendant_tab_ids: [],
  };
}

function seededRuntimeStorage(
  targets: ChromeNativeTarget[],
  guards: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    unicli_browser_session_id: BROWSER_SESSION_ID,
    unicli_target_ledger_v1: {
      version: 1,
      entries: targets.map((target) => ({ state: "target", target })),
    },
    unicli_background_guards_v1: guards,
    unicli_background_ui_violations_v1: [],
  };
}

function readSeededGuardSafeState(
  storage: Record<string, unknown>,
): { focused_window_id?: number | null } | undefined {
  const guards = storage.unicli_background_guards_v1;
  if (!Array.isArray(guards)) return undefined;
  const first = guards[0];
  if (typeof first !== "object" || first === null) return undefined;
  const safeState = (first as { safe_state?: unknown }).safe_state;
  if (typeof safeState !== "object" || safeState === null) return undefined;
  return safeState as { focused_window_id?: number | null };
}

function installPopupOpeningClick(
  harness: ReturnType<typeof installStatefulChrome>,
  openPopup: () => void,
): void {
  let opened = false;
  harness.chrome.debugger.sendCommand.mockImplementation(
    async (_target: unknown, method: string, params: unknown) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 2 };
      if (method === "DOM.getBoxModel") {
        return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
      }
      if (
        method === "Input.dispatchMouseEvent" &&
        (params as { type?: string } | undefined)?.type === "mousePressed" &&
        !opened
      ) {
        opened = true;
        openPopup();
      }
      return {};
    },
  );
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
    createGate?: Promise<void>;
    storageGetGate?: Promise<void>;
    sessionStorage?: Record<string, unknown>;
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
  let nextTabId = Math.max(10, ...tabs.map((tab) => tab.id)) + 1;
  let nextWindowId = Math.max(7, ...windows.map((window) => window.id)) + 1;
  let nextDocumentId = 1;
  const tabsOnCreated = createEvent<[TabState]>();
  const tabsOnActivated = createEvent<[{ tabId: number; windowId: number }]>();
  const tabsOnUpdated = createEvent<[number, { status?: string }, TabState]>();
  const tabsOnRemoved = createEvent<[number]>();
  const windowsOnFocusChanged = createEvent<[number]>();
  const webNavigationOnCreatedNavigationTarget = createEvent<
    [
      {
        sourceTabId: number;
        tabId: number;
        sourceFrameId: number;
        sourceProcessId: number;
        url: string;
        timeStamp: number;
      },
    ]
  >();
  const webNavigationOnBeforeNavigate =
    createEvent<[chrome.webNavigation.WebNavigationBaseCallbackDetails]>();
  const webNavigationOnCommitted =
    createEvent<
      [chrome.webNavigation.WebNavigationTransitionCallbackDetails]
    >();
  const webNavigationOnCompleted =
    createEvent<[chrome.webNavigation.WebNavigationFramedCallbackDetails]>();
  const webNavigationOnErrorOccurred =
    createEvent<
      [chrome.webNavigation.WebNavigationFramedErrorCallbackDetails]
    >();
  const webNavigationOnHistoryStateUpdated =
    createEvent<
      [chrome.webNavigation.WebNavigationTransitionCallbackDetails]
    >();
  const webNavigationOnReferenceFragmentUpdated =
    createEvent<
      [chrome.webNavigation.WebNavigationTransitionCallbackDetails]
    >();
  const debuggerOnEvent =
    createEvent<[{ tabId?: number }, string, Record<string, unknown>]>();
  const debuggerOnDetach = createEvent<[{ tabId?: number }, string]>();
  const runtimeOnInstalled = createEvent<[]>();
  const runtimeOnStartup = createEvent<[]>();
  const alarmsOnAlarm = createEvent<[{ name: string }]>();
  const nativeOnMessage = createEvent<[unknown]>();
  const nativeOnDisconnect = createEvent<[]>();
  const nativeMessages: unknown[] = [];
  const removedTabIds: number[] = [];
  let beforeRemoveTab: (() => void) | null = null;
  let beforeEveryRemoveTab: ((tabId: number) => void) | null = null;
  const sessionStorage: Record<string, unknown> = {
    unicli_browser_session_id: BROWSER_SESSION_ID,
    ...structuredClone(options.sessionStorage ?? {}),
  };
  const nativePort = {
    onMessage: nativeOnMessage,
    onDisconnect: nativeOnDisconnect,
    postMessage: vi.fn((message: unknown) => nativeMessages.push(message)),
    disconnect: vi.fn(() => nativeOnDisconnect.emit()),
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
    tabsOnActivated.emit({ tabId: tab.id, windowId: tab.windowId });
  };
  const focusWindow = (windowId: number): void => {
    for (const candidate of windows)
      candidate.focused = candidate.id === windowId;
    windowsOnFocusChanged.emit(windowId);
  };
  const openTab = (input: {
    windowId?: number;
    newWindowType?: WindowState["type"];
    focused?: boolean;
    active?: boolean;
    openerTabId?: number;
    url?: string;
    complete?: boolean;
  }): TabState => {
    let windowId = input.windowId;
    if (windowId === undefined) {
      const window: WindowState = {
        id: nextWindowId++,
        focused: input.focused === true,
        type: input.newWindowType ?? "normal",
      };
      windows.push(window);
      windowId = window.id;
      if (window.focused) focusWindow(window.id);
    }
    const tab: TabState = {
      id: nextTabId++,
      windowId,
      active: input.active === true,
      url: input.url ?? "about:blank",
      title: input.url ?? "about:blank",
      lastAccessed: Date.now(),
      ...(input.openerTabId === undefined
        ? {}
        : { openerTabId: input.openerTabId }),
    };
    tabs.push(tab);
    if (tab.active) activateTab(tab);
    if (input.focused === true) focusWindow(windowId);
    tabsOnCreated.emit(structuredClone(tab));
    if (input.complete !== false) {
      queueMicrotask(() =>
        tabsOnUpdated.emit(
          tab.id,
          { status: "complete" },
          structuredClone(tab),
        ),
      );
    }
    return structuredClone(tab);
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
          await options.createGate;
          const windowId = create.windowId ?? windows[0]?.id;
          if (windowId === undefined) throw new Error("No target window");
          return openTab({
            windowId,
            active:
              create.active === true ||
              options.activateBackgroundCreate === true,
            url: create.url,
          });
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
            const documentId = `document:${String(nextDocumentId++)}`;
            queueMicrotask(() => {
              const timeStamp = Date.now();
              webNavigationOnBeforeNavigate.emit({
                documentLifecycle: "active",
                frameId: 0,
                frameType: "outermost_frame",
                parentFrameId: -1,
                processId: 1,
                tabId,
                timeStamp,
                url: update.url!,
              });
              webNavigationOnCommitted.emit({
                documentLifecycle: "active",
                documentId,
                frameId: 0,
                frameType: "outermost_frame",
                parentFrameId: -1,
                processId: 1,
                tabId,
                timeStamp,
                transitionQualifiers: [],
                transitionType: "link",
                url: update.url!,
              });
              webNavigationOnCompleted.emit({
                documentLifecycle: "active",
                documentId,
                frameId: 0,
                frameType: "outermost_frame",
                parentFrameId: -1,
                processId: 1,
                tabId,
                timeStamp,
                url: update.url!,
              });
              tabsOnUpdated.emit(
                tabId,
                { status: "complete" },
                structuredClone(tab),
              );
            });
          }
          return structuredClone(tab);
        },
      ),
      remove: vi.fn(async (tabId: number) => {
        const index = tabs.findIndex((candidate) => candidate.id === tabId);
        if (index < 0) throw new Error(`No tab with id ${String(tabId)}`);
        beforeEveryRemoveTab?.(tabId);
        beforeRemoveTab?.();
        beforeRemoveTab = null;
        const [removed] = tabs.splice(index, 1);
        removedTabIds.push(tabId);
        if (removed.active) {
          const replacement = tabs.find(
            (candidate) => candidate.windowId === removed.windowId,
          );
          if (replacement) replacement.active = true;
        }
        if (
          !tabs.some((candidate) => candidate.windowId === removed.windowId)
        ) {
          const windowIndex = windows.findIndex(
            (candidate) => candidate.id === removed.windowId,
          );
          const removedWindow =
            windowIndex < 0 ? undefined : windows.splice(windowIndex, 1)[0];
          if (removedWindow?.focused && windows[0]) focusWindow(windows[0].id);
        }
        tabsOnRemoved.emit(tabId);
      }),
      onCreated: tabsOnCreated,
      onActivated: tabsOnActivated,
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
          tabsOnCreated.emit(structuredClone(tab));
          return { ...structuredClone(window), tabs: [structuredClone(tab)] };
        },
      ),
      remove: vi.fn(async (windowId: number) => {
        const index = windows.findIndex(
          (candidate) => candidate.id === windowId,
        );
        if (index < 0) {
          throw new Error(`No window with id ${String(windowId)}`);
        }
        windows.splice(index, 1);
        for (let tabIndex = tabs.length - 1; tabIndex >= 0; tabIndex--) {
          if (tabs[tabIndex]!.windowId === windowId) tabs.splice(tabIndex, 1);
        }
      }),
      onFocusChanged: windowsOnFocusChanged,
    },
    webNavigation: {
      onBeforeNavigate: webNavigationOnBeforeNavigate,
      onCommitted: webNavigationOnCommitted,
      onCompleted: webNavigationOnCompleted,
      onErrorOccurred: webNavigationOnErrorOccurred,
      onHistoryStateUpdated: webNavigationOnHistoryStateUpdated,
      onReferenceFragmentUpdated: webNavigationOnReferenceFragmentUpdated,
      onCreatedNavigationTarget: webNavigationOnCreatedNavigationTarget,
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
        get: vi.fn(async (key: string) => {
          await options.storageGetGate;
          return key in sessionStorage ? { [key]: sessionStorage[key] } : {};
        }),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(sessionStorage, structuredClone(values));
        }),
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
    webNavigationOnCreatedNavigationTarget,
    webNavigationOnBeforeNavigate,
    webNavigationOnCommitted,
    webNavigationOnCompleted,
    openTab,
    activateTab: (tabId: number) => {
      const tab = tabs.find((candidate) => candidate.id === tabId);
      if (!tab) throw new Error(`No tab with id ${String(tabId)}`);
      activateTab(tab);
    },
    focusWindow,
    emitNavigationTarget: (sourceTabId: number, tabId: number) => {
      webNavigationOnCreatedNavigationTarget.emit({
        sourceTabId,
        tabId,
        sourceFrameId: 0,
        sourceProcessId: 1,
        url: "https://popup.test/",
        timeStamp: Date.now(),
      });
    },
    beforeRemoveTab: (listener: () => void) => {
      beforeRemoveTab = listener;
    },
    beforeEveryRemoveTab: (listener: (tabId: number) => void) => {
      beforeEveryRemoveTab = listener;
    },
    updateTabUrl: (tabId: number, url: string) => {
      const tab = tabs.find((candidate) => candidate.id === tabId);
      if (!tab) throw new Error(`No tab with id ${String(tabId)}`);
      tab.url = url;
      tab.title = url;
      return structuredClone(tab);
    },
    removedTabIds,
    targetLedger: () =>
      structuredClone(
        sessionStorage.unicli_target_ledger_v1 ?? {
          version: 1,
          entries: [],
        },
      ),
    setBrowserSessionId: (value: string) => {
      sessionStorage.unicli_browser_session_id = value;
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
    tabsState: () => structuredClone(tabs),
    windowsState: () => structuredClone(windows),
    sessionStorageState: () => structuredClone(sessionStorage),
  };
}

interface WindowState {
  id: number;
  focused: boolean;
  type: "normal" | "popup";
}

interface TabState {
  id: number;
  windowId: number;
  active: boolean;
  url: string;
  title: string;
  lastAccessed?: number;
  openerTabId?: number;
}
