import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener<T extends unknown[]> = (...args: T) => void;

function createEvent<T extends unknown[]>() {
  const listeners: Listener<T>[] = [];
  return {
    addListener: vi.fn((listener: Listener<T>) => {
      listeners.push(listener);
    }),
    removeListener: vi.fn((listener: Listener<T>) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    }),
    emit: (...args: T) => {
      for (const listener of listeners.slice()) listener(...args);
    },
    listenerCount: () => listeners.length,
  };
}

function installChromeMock() {
  const debuggerOnEvent =
    createEvent<[{ tabId?: number }, string, Record<string, unknown>]>();
  const debuggerOnDetach = createEvent<[{ tabId?: number }, string]>();
  const tabsOnRemoved = createEvent<[number]>();
  const runtimeOnInstalled = createEvent<[]>();
  const runtimeOnStartup = createEvent<[]>();
  const alarmsOnAlarm = createEvent<[{ name: string }]>();
  const tabsOnUpdated =
    createEvent<[number, { status?: string }, { id?: number }]>();

  const sendCommand = vi.fn(
    async (
      _target: { tabId?: number },
      method: string,
      params?: Record<string, unknown>,
    ) => {
      if (method === "Network.getResponseBody") {
        return { body: `body:${String(params?.requestId)}` };
      }
      return {};
    },
  );

  const chrome = {
    debugger: {
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand,
      onEvent: debuggerOnEvent,
      onDetach: debuggerOnDetach,
    },
    tabs: {
      query: vi.fn().mockResolvedValue([
        {
          id: 42,
          windowId: 7,
          url: "https://example.com",
          title: "Example",
        },
      ]),
      update: vi.fn().mockResolvedValue(undefined),
      onRemoved: tabsOnRemoved,
      onUpdated: tabsOnUpdated,
    },
    windows: {
      create: vi.fn().mockResolvedValue({
        id: 7,
        tabs: [{ id: 42, windowId: 7, url: "about:blank" }],
      }),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    cookies: {
      getAll: vi.fn().mockResolvedValue([]),
    },
    alarms: {
      create: vi.fn(),
      onAlarm: alarmsOnAlarm,
    },
    runtime: {
      getManifest: vi.fn(() => ({ version: "0.214.0-test" })),
      onInstalled: runtimeOnInstalled,
      onStartup: runtimeOnStartup,
    },
  };

  vi.stubGlobal("chrome", chrome);
  return {
    chrome,
    debuggerOnEvent,
    debuggerOnDetach,
    tabsOnRemoved,
    runtimeOnInstalled,
  };
}

async function importNetworkCapture() {
  return import("../../../extension/src/network-capture.js");
}

async function startBackgroundHarness(runtimeOnInstalled: {
  emit: () => void;
}) {
  const sentMessages: unknown[] = [];
  class FakeWebSocket {
    static OPEN = 1;
    readyState = FakeWebSocket.OPEN;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    send = vi.fn((raw: string) => {
      sentMessages.push(JSON.parse(raw));
    });
    close = vi.fn();
    constructor(_url: string) {
      setTimeout(() => this.onopen?.(), 0);
    }
  }
  const sockets: FakeWebSocket[] = [];
  vi.stubGlobal(
    "WebSocket",
    vi.fn((url: string) => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    }),
  );
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

  await import("../../../extension/src/background.js");
  runtimeOnInstalled.emit();
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  await vi.waitFor(() =>
    expect(sentMessages).toContainEqual({
      type: "hello",
      version: "0.214.0-test",
    }),
  );

  return { sockets, sentMessages };
}

describe("extension network capture", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts capture by attaching the debugger, enabling Network, and clearing old entries", async () => {
    const { chrome, debuggerOnEvent } = installChromeMock();
    const capture = await importNetworkCapture();

    await capture.startNetworkCapture(42);
    debuggerOnEvent.emit({ tabId: 42 }, "Network.responseReceived", {
      requestId: "r1",
      response: {
        url: "https://example.com/api/old",
        status: 200,
        headers: { "content-type": "application/json" },
      },
      timestamp: 1,
    });
    expect(capture.readNetworkCapture(42)).toHaveLength(1);

    await capture.startNetworkCapture(42, "users");

    expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 42 }, "1.3");
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 42 },
      "Network.enable",
    );
    expect(capture.readNetworkCapture(42)).toEqual([]);
  });

  it("captures matching substring responses and records request method", async () => {
    const { debuggerOnEvent } = installChromeMock();
    const capture = await importNetworkCapture();
    await capture.startNetworkCapture(42, "api/users");

    debuggerOnEvent.emit({ tabId: 42 }, "Network.requestWillBeSent", {
      requestId: "r1",
      request: { method: "POST" },
    });
    debuggerOnEvent.emit({ tabId: 42 }, "Network.responseReceived", {
      requestId: "r1",
      response: {
        url: "https://example.com/api/users",
        status: 201,
        mimeType: "application/json",
      },
      timestamp: 10,
    });
    debuggerOnEvent.emit({ tabId: 42 }, "Network.responseReceived", {
      requestId: "r2",
      response: {
        url: "https://example.com/assets/app.js",
        status: 200,
        mimeType: "application/javascript",
      },
      timestamp: 11,
    });

    expect(capture.readNetworkCapture(42)).toEqual([
      {
        url: "https://example.com/api/users",
        method: "POST",
        status: 201,
        contentType: "application/json",
        size: 0,
        timestamp: 10,
      },
    ]);
  });

  it("supports slash regex filters without the global flag", async () => {
    const { debuggerOnEvent } = installChromeMock();
    const capture = await importNetworkCapture();
    await capture.startNetworkCapture(42, "/api\\/v1/i");

    debuggerOnEvent.emit({ tabId: 42 }, "Network.responseReceived", {
      requestId: "r1",
      response: {
        url: "https://example.com/API/v1/items",
        status: 200,
        mimeType: "application/json",
      },
      timestamp: 12,
    });

    expect(capture.readNetworkCapture(42)).toHaveLength(1);
  });

  it("rejects invalid slash regex filters with a useful error", async () => {
    installChromeMock();
    const capture = await importNetworkCapture();

    await expect(capture.startNetworkCapture(42, "/[/i")).rejects.toThrow(
      /Invalid network capture regex/i,
    );
  });

  it("updates encoded size and captures response bodies best effort", async () => {
    const { chrome, debuggerOnEvent } = installChromeMock();
    const capture = await importNetworkCapture();
    await capture.startNetworkCapture(42);

    debuggerOnEvent.emit({ tabId: 42 }, "Network.requestWillBeSent", {
      requestId: "r1",
      request: { method: "GET" },
    });
    debuggerOnEvent.emit({ tabId: 42 }, "Network.responseReceived", {
      requestId: "r1",
      response: {
        url: "https://example.com/api/data",
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
      timestamp: 13,
    });
    debuggerOnEvent.emit({ tabId: 42 }, "Network.loadingFinished", {
      requestId: "r1",
      encodedDataLength: 321,
    });
    await vi.waitFor(() => {
      expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
        { tabId: 42 },
        "Network.getResponseBody",
        { requestId: "r1" },
      );
    });

    expect(capture.readNetworkCapture(42)).toEqual([
      {
        url: "https://example.com/api/data",
        method: "GET",
        status: 200,
        contentType: "application/json; charset=utf-8",
        size: 321,
        responseBody: "body:r1",
        timestamp: 13,
      },
    ]);
  });

  it("read before start returns an empty array and read drains the buffer", async () => {
    const { debuggerOnEvent } = installChromeMock();
    const capture = await importNetworkCapture();

    expect(capture.readNetworkCapture(42)).toEqual([]);
    await capture.startNetworkCapture(42);
    debuggerOnEvent.emit({ tabId: 42 }, "Network.responseReceived", {
      requestId: "r1",
      response: {
        url: "https://example.com/api/data",
        status: 200,
        mimeType: "application/json",
      },
      timestamp: 14,
    });

    expect(capture.readNetworkCapture(42)).toHaveLength(1);
    expect(capture.readNetworkCapture(42)).toEqual([]);
  });

  it("clears request method state when read drains captured entries", async () => {
    const { debuggerOnEvent } = installChromeMock();
    const capture = await importNetworkCapture();

    await capture.startNetworkCapture(42);
    debuggerOnEvent.emit({ tabId: 42 }, "Network.requestWillBeSent", {
      requestId: "reused",
      request: { method: "POST" },
    });
    debuggerOnEvent.emit({ tabId: 42 }, "Network.responseReceived", {
      requestId: "reused",
      response: {
        url: "https://example.com/api/first",
        status: 200,
        mimeType: "application/json",
      },
      timestamp: 18,
    });
    expect(capture.readNetworkCapture(42)[0]?.method).toBe("POST");

    debuggerOnEvent.emit({ tabId: 42 }, "Network.responseReceived", {
      requestId: "reused",
      response: {
        url: "https://example.com/api/second",
        status: 200,
        mimeType: "application/json",
      },
      timestamp: 19,
    });

    expect(capture.readNetworkCapture(42)[0]?.method).toBe("GET");
  });

  it("keeps request linkage for retained entries after capture buffer eviction", async () => {
    const { chrome, debuggerOnEvent } = installChromeMock();
    const capture = await importNetworkCapture();

    await capture.startNetworkCapture(42);
    for (let index = 0; index < 101; index++) {
      debuggerOnEvent.emit({ tabId: 42 }, "Network.responseReceived", {
        requestId: `r${index}`,
        response: {
          url: `https://example.com/api/${index}`,
          status: 200,
          mimeType: "application/json",
        },
        timestamp: index,
      });
    }
    debuggerOnEvent.emit({ tabId: 42 }, "Network.loadingFinished", {
      requestId: "r100",
      encodedDataLength: 999,
    });
    await vi.waitFor(() => {
      expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
        { tabId: 42 },
        "Network.getResponseBody",
        { requestId: "r100" },
      );
    });

    const entries = capture.readNetworkCapture(42);
    expect(entries).toHaveLength(100);
    expect(entries.at(-1)).toMatchObject({
      url: "https://example.com/api/100",
      size: 999,
      responseBody: "body:r100",
    });
  });

  it("decodes base64 response bodies as utf-8 text", async () => {
    const { chrome, debuggerOnEvent } = installChromeMock();
    chrome.debugger.sendCommand = vi.fn(async (_target, method) => {
      if (method === "Network.getResponseBody") {
        return {
          body: Buffer.from("你好", "utf-8").toString("base64"),
          base64Encoded: true,
        };
      }
      return {};
    });
    const capture = await importNetworkCapture();

    await capture.startNetworkCapture(42);
    debuggerOnEvent.emit({ tabId: 42 }, "Network.responseReceived", {
      requestId: "utf8",
      response: {
        url: "https://example.com/api/utf8",
        status: 200,
        mimeType: "text/plain",
      },
      timestamp: 20,
    });
    debuggerOnEvent.emit({ tabId: 42 }, "Network.loadingFinished", {
      requestId: "utf8",
      encodedDataLength: 6,
    });
    await vi.waitFor(() =>
      expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
        { tabId: 42 },
        "Network.getResponseBody",
        { requestId: "utf8" },
      ),
    );
    await Promise.resolve();

    expect(capture.readNetworkCapture(42)[0]?.responseBody).toBe("你好");
  });

  it("clears capture state on debugger detach and tab removal", async () => {
    const { debuggerOnEvent, debuggerOnDetach, tabsOnRemoved } =
      installChromeMock();
    const capture = await importNetworkCapture();

    await capture.startNetworkCapture(42);
    debuggerOnEvent.emit({ tabId: 42 }, "Network.responseReceived", {
      requestId: "r1",
      response: {
        url: "https://example.com/api/data",
        status: 200,
        mimeType: "application/json",
      },
      timestamp: 15,
    });
    debuggerOnDetach.emit({ tabId: 42 }, "target_closed");
    expect(capture.readNetworkCapture(42)).toEqual([]);

    await capture.startNetworkCapture(42);
    debuggerOnEvent.emit({ tabId: 42 }, "Network.responseReceived", {
      requestId: "r2",
      response: {
        url: "https://example.com/api/data",
        status: 200,
        mimeType: "application/json",
      },
      timestamp: 16,
    });
    tabsOnRemoved.emit(42);
    expect(capture.readNetworkCapture(42)).toEqual([]);
  });

  it("registers listeners idempotently", async () => {
    const { debuggerOnEvent, debuggerOnDetach, tabsOnRemoved } =
      installChromeMock();
    const capture = await importNetworkCapture();

    capture.registerNetworkCaptureListeners();
    capture.registerNetworkCaptureListeners();
    capture.registerNetworkCaptureListeners();

    expect(debuggerOnEvent.listenerCount()).toBe(1);
    expect(debuggerOnDetach.listenerCount()).toBe(1);
    expect(tabsOnRemoved.listenerCount()).toBe(1);
  });
});

describe("background network capture routing", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("routes network capture start and read through the current workspace tab", async () => {
    const { chrome, debuggerOnEvent, runtimeOnInstalled } = installChromeMock();
    const { sockets, sentMessages } =
      await startBackgroundHarness(runtimeOnInstalled);

    sockets[0]!.onmessage?.({
      data: JSON.stringify({
        id: "start",
        action: "network-capture-start",
        workspace: "default",
        pattern: "api",
      }),
    });
    await vi.waitFor(() =>
      expect(sentMessages).toContainEqual({
        id: "start",
        ok: true,
        data: { started: true },
      }),
    );
    expect(chrome.windows.create).toHaveBeenCalled();

    debuggerOnEvent.emit({ tabId: 42 }, "Network.responseReceived", {
      requestId: "r1",
      response: {
        url: "https://example.com/api/data",
        status: 200,
        mimeType: "application/json",
      },
      timestamp: 17,
    });
    sockets[0]!.onmessage?.({
      data: JSON.stringify({
        id: "read",
        action: "network-capture-read",
        workspace: "default",
      }),
    });

    await vi.waitFor(() =>
      expect(sentMessages).toContainEqual({
        id: "read",
        ok: true,
        data: [
          {
            url: "https://example.com/api/data",
            method: "GET",
            status: 200,
            contentType: "application/json",
            size: 0,
            timestamp: 17,
          },
        ],
      }),
    );
  });

  it("does not close a borrowed tab window when closing its workspace", async () => {
    const { chrome, runtimeOnInstalled } = installChromeMock();
    chrome.tabs.query = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: 88,
          windowId: 900,
          url: "https://example.com/feed",
          title: "Borrowed",
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const { sockets, sentMessages } =
      await startBackgroundHarness(runtimeOnInstalled);

    sockets[0]!.onmessage?.({
      data: JSON.stringify({
        id: "bind",
        action: "bind-current",
        workspace: "borrowed",
        matchDomain: "example.com",
      }),
    });
    await vi.waitFor(() =>
      expect(sentMessages).toContainEqual({
        id: "bind",
        ok: true,
        data: {
          tabId: 88,
          url: "https://example.com/feed",
          title: "Borrowed",
          workspace: "borrowed",
        },
      }),
    );

    sockets[0]!.onmessage?.({
      data: JSON.stringify({
        id: "close",
        action: "close-window",
        workspace: "borrowed",
      }),
    });
    await vi.waitFor(() =>
      expect(sentMessages).toContainEqual({ id: "close", ok: true }),
    );

    expect(chrome.windows.remove).not.toHaveBeenCalled();
  });

  it("matches bind domains by host boundary instead of substring", async () => {
    const { runtimeOnInstalled } = installChromeMock();
    chrome.tabs.query = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: 10,
          windowId: 10,
          url: "https://notgithub.com/feed",
          title: "Wrong",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 11,
          windowId: 11,
          url: "https://sub.github.com/feed",
          title: "Right",
        },
      ])
      .mockResolvedValueOnce([]);
    const { sockets, sentMessages } =
      await startBackgroundHarness(runtimeOnInstalled);

    sockets[0]!.onmessage?.({
      data: JSON.stringify({
        id: "bind",
        action: "bind-current",
        workspace: "github",
        matchDomain: "github.com",
      }),
    });

    await vi.waitFor(() =>
      expect(sentMessages).toContainEqual({
        id: "bind",
        ok: true,
        data: {
          tabId: 11,
          url: "https://sub.github.com/feed",
          title: "Right",
          workspace: "github",
        },
      }),
    );
  });
});
