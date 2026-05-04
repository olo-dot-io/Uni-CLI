/**
 * CdpBrowserTransport adapter tests.
 *
 * CdpBrowserTransport wraps the existing `BrowserPage` (IPage impl) behind
 * the TransportAdapter interface. For unit testing we inject a mock IPage
 * so we don't need a live Chrome at test time.
 */

import { describe, it, expect, vi } from "vitest";
import { CdpBrowserTransport } from "../../../../src/transport/adapters/cdp-browser.js";
import { createTransportBus } from "../../../../src/transport/bus.js";
import type { TransportContext } from "../../../../src/transport/types.js";
import type { IPage } from "../../../../src/types.js";

vi.mock("../../../../src/browser/page.js", () => ({
  BrowserPage: {
    connect: vi
      .fn()
      .mockRejectedValue(
        new Error("default browser should not open before cdp_attach"),
      ),
  },
}));

vi.mock("../../../../src/browser/launcher.js", () => ({
  launchChrome: vi
    .fn()
    .mockRejectedValue(
      new Error("default browser should not launch before cdp_attach"),
    ),
}));

function makeMockPage(overrides: Partial<IPage> = {}): IPage {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue("evaluated"),
    wait: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    waitFor: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockResolvedValue(undefined),
    insertText: vi.fn().mockResolvedValue(undefined),
    scroll: vi.fn().mockResolvedValue(undefined),
    autoScroll: vi.fn().mockResolvedValue(undefined),
    nativeClick: vi.fn().mockResolvedValue(undefined),
    nativeKeyPress: vi.fn().mockResolvedValue(undefined),
    setFileInput: vi.fn().mockResolvedValue(undefined),
    cookies: vi.fn().mockResolvedValue({}),
    title: vi.fn().mockResolvedValue("test title"),
    url: vi.fn().mockResolvedValue("https://example.com/"),
    snapshot: vi.fn().mockResolvedValue("snapshot data"),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("png data")),
    networkRequests: vi.fn().mockResolvedValue([]),
    addInitScript: vi.fn().mockResolvedValue(undefined),
    sendCDP: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
    closeWindow: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeCtx(): TransportContext {
  return { vars: {}, bus: createTransportBus() };
}

describe("CdpBrowserTransport", () => {
  it("declares kind = cdp-browser", () => {
    const t = new CdpBrowserTransport();
    expect(t.kind).toBe("cdp-browser");
  });

  it("capability includes navigate, click, type, scroll, press, wait, evaluate, snapshot, screenshot", () => {
    const t = new CdpBrowserTransport();
    expect(t.capability.steps).toEqual(
      expect.arrayContaining([
        "navigate",
        "cdp_attach",
        "click",
        "type",
        "press",
        "scroll",
        "wait",
        "evaluate",
        "snapshot",
        "screenshot",
      ]),
    );
    expect(t.capability.snapshotFormats).toEqual(
      expect.arrayContaining(["dom-ax", "screenshot"]),
    );
    expect(t.capability.mutatesHost).toBe(true);
  });

  it("keeps the default browser page lazy before cdp_attach", async () => {
    const t = new CdpBrowserTransport();

    await expect(t.open(makeCtx())).resolves.toBeUndefined();
    const res = await t.action({ kind: "cdp_attach", params: {} });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.exit_code).toBe(2);
      expect(res.error.reason).toMatch(/port|app/i);
    }
  });

  it("attaches to an explicit CDP port and reuses that page for later actions", async () => {
    const page = makeMockPage({
      evaluate: vi.fn().mockResolvedValue("attached renderer"),
    });
    const targets = [
      {
        id: "page-1",
        type: "page",
        title: "VS Code",
        url: "vscode-file://workspace",
        webSocketDebuggerUrl: "ws://127.0.0.1:9333/page-1",
      },
    ];
    const t = new CdpBrowserTransport({
      pageFactory: async () => {
        throw new Error("default page factory should not run for attach");
      },
      pageConnector: vi.fn().mockResolvedValue(page),
      cdpProbe: vi.fn().mockResolvedValue({
        port: 9333,
        webSocketDebuggerUrl: "ws://127.0.0.1:9333/page-1",
        targets,
      }),
    });
    await t.open(makeCtx());

    const attach = await t.action({
      kind: "cdp_attach",
      params: { port: 9333 },
    });
    const evaluated = await t.action<string>({
      kind: "evaluate",
      params: { script: "document.title" },
    });

    expect(attach.ok).toBe(true);
    if (attach.ok) {
      expect(attach.data).toMatchObject({
        port: 9333,
        webSocketDebuggerUrl: "ws://127.0.0.1:9333/page-1",
        targets,
        relaunched: false,
      });
    }
    expect(evaluated.ok).toBe(true);
    if (evaluated.ok) expect(evaluated.data).toBe("attached renderer");
    expect(page.evaluate).toHaveBeenCalledWith("document.title");
  });

  it("relaunches a known Electron app with its CDP port when attach by app misses", async () => {
    const page = makeMockPage();
    const targets = [
      {
        id: "app-1",
        type: "app",
        title: "NeteaseMusic",
        url: "app://netease",
        webSocketDebuggerUrl: "ws://127.0.0.1:9238/app-1",
      },
    ];
    const cdpProbe = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
      port: 9238,
      webSocketDebuggerUrl: "ws://127.0.0.1:9238/app-1",
      targets,
    });
    const appLauncher = vi.fn().mockResolvedValue(undefined);
    const pageConnector = vi.fn().mockResolvedValue(page);
    const t = new CdpBrowserTransport({
      pageFactory: async () => {
        throw new Error("default page factory should not run for attach");
      },
      pageConnector,
      cdpProbe,
      appLauncher,
    } as ConstructorParameters<typeof CdpBrowserTransport>[0] & {
      appLauncher: typeof appLauncher;
    });
    await t.open(makeCtx());

    const attach = await t.action({
      kind: "cdp_attach",
      params: { app: "netease music app" },
    });

    expect(attach.ok).toBe(true);
    if (attach.ok) {
      expect(attach.data).toMatchObject({
        app: "netease music app",
        port: 9238,
        relaunched: true,
        targets,
      });
    }
    expect(appLauncher).toHaveBeenCalledWith(
      expect.objectContaining({
        app: "netease music app",
        port: 9238,
        processName: "NeteaseMusic",
        bundleId: "com.netease.163music",
      }),
    );
    expect(cdpProbe).toHaveBeenCalledTimes(2);
    expect(pageConnector).toHaveBeenCalledWith(
      9238,
      "ws://127.0.0.1:9238/app-1",
    );
  });

  it("refuses risky app relaunch unless explicitly confirmed", async () => {
    const cdpProbe = vi.fn().mockResolvedValue(null);
    const appLauncher = vi
      .fn()
      .mockRejectedValue(new Error("unsafe relaunch attempted"));
    const t = new CdpBrowserTransport({
      pageFactory: async () => {
        throw new Error("default page factory should not run for attach");
      },
      cdpProbe,
      appLauncher,
    } as ConstructorParameters<typeof CdpBrowserTransport>[0] & {
      appLauncher: typeof appLauncher;
    });
    await t.open(makeCtx());

    const attach = await t.action({
      kind: "cdp_attach",
      params: { app: "notion" },
    });

    expect(attach.ok).toBe(false);
    if (!attach.ok) {
      expect(attach.error.exit_code).toBe(77);
      expect(attach.error.reason).toMatch(/confirm-relaunch/i);
      expect(attach.error.minimum_capability).toBe(
        "cdp-browser.cdp_attach.confirm_relaunch",
      );
    }
    expect(appLauncher).not.toHaveBeenCalled();
    expect(cdpProbe).toHaveBeenCalledTimes(1);
  });

  it("relaunches a risky app after explicit confirmation", async () => {
    const page = makeMockPage();
    const targets = [
      {
        id: "notion-1",
        type: "page",
        title: "Notion",
        url: "notion://workspace",
        webSocketDebuggerUrl: "ws://127.0.0.1:9230/notion-1",
      },
    ];
    const cdpProbe = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
      port: 9230,
      webSocketDebuggerUrl: "ws://127.0.0.1:9230/notion-1",
      targets,
    });
    const appLauncher = vi.fn().mockResolvedValue(undefined);
    const pageConnector = vi.fn().mockResolvedValue(page);
    const t = new CdpBrowserTransport({
      pageFactory: async () => {
        throw new Error("default page factory should not run for attach");
      },
      pageConnector,
      cdpProbe,
      appLauncher,
    } as ConstructorParameters<typeof CdpBrowserTransport>[0] & {
      appLauncher: typeof appLauncher;
    });
    await t.open(makeCtx());

    const attach = await t.action({
      kind: "cdp_attach",
      params: { app: "notion", confirmRelaunch: true },
    });

    expect(attach.ok).toBe(true);
    if (attach.ok) {
      expect(attach.data).toMatchObject({
        app: "notion",
        port: 9230,
        relaunched: true,
        targets,
      });
    }
    expect(appLauncher).toHaveBeenCalledWith(
      expect.objectContaining({
        app: "notion",
        port: 9230,
        processName: "Notion",
        relaunchLosesSession: true,
      }),
    );
  });

  it("cdp_attach requires either port or app", async () => {
    const page = makeMockPage();
    const t = new CdpBrowserTransport({ pageFactory: async () => page });
    await t.open(makeCtx());

    const res = await t.action({ kind: "cdp_attach", params: {} });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.exit_code).toBe(2);
      expect(res.error.reason).toMatch(/port|app/i);
    }
  });

  it("delegates navigate to IPage.goto", async () => {
    const page = makeMockPage();
    const t = new CdpBrowserTransport({ pageFactory: async () => page });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "navigate",
      params: { url: "https://example.com" },
    });
    expect(res.ok).toBe(true);
    expect(page.goto).toHaveBeenCalledWith(
      "https://example.com",
      expect.any(Object),
    );
  });

  it("delegates click to IPage.click", async () => {
    const page = makeMockPage();
    const t = new CdpBrowserTransport({ pageFactory: async () => page });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "click",
      params: { selector: "#go" },
    });
    expect(res.ok).toBe(true);
    expect(page.click).toHaveBeenCalledWith("#go");
  });

  it("delegates type to IPage.type", async () => {
    const page = makeMockPage();
    const t = new CdpBrowserTransport({ pageFactory: async () => page });
    await t.open(makeCtx());
    await t.action({
      kind: "type",
      params: { selector: "input", text: "hello" },
    });
    expect(page.type).toHaveBeenCalledWith("input", "hello");
  });

  it("delegates evaluate to IPage.evaluate", async () => {
    const page = makeMockPage({
      evaluate: vi.fn().mockResolvedValue(42),
    });
    const t = new CdpBrowserTransport({ pageFactory: async () => page });
    await t.open(makeCtx());
    const res = await t.action<number>({
      kind: "evaluate",
      params: { script: "6*7" },
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toBe(42);
  });

  it("reconnects from persisted CDP session params for evaluate", async () => {
    const page = makeMockPage({
      evaluate: vi.fn().mockResolvedValue("Editor"),
    });
    const pageConnector = vi.fn().mockResolvedValue(page);
    const t = new CdpBrowserTransport({
      pageFactory: async () => {
        throw new Error("default page factory should not run with session");
      },
      pageConnector,
      cdpProbe: vi.fn(),
    });
    await t.open(makeCtx());

    const res = await t.action<string>({
      kind: "evaluate",
      params: {
        script: "document.title",
        port: 9240,
        webSocketDebuggerUrl: "ws://127.0.0.1:9240/page-1",
      },
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toBe("Editor");
    expect(pageConnector).toHaveBeenCalledWith(
      9240,
      "ws://127.0.0.1:9240/page-1",
    );
    expect(page.evaluate).toHaveBeenCalledWith("document.title");
  });

  it("returns err envelope when required param missing", async () => {
    const page = makeMockPage();
    const t = new CdpBrowserTransport({ pageFactory: async () => page });
    await t.open(makeCtx());
    const res = await t.action({ kind: "navigate", params: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.reason).toMatch(/url/i);
      expect(res.error.exit_code).toBe(2);
    }
  });

  it("never throws when underlying page throws — returns err envelope", async () => {
    const page = makeMockPage({
      click: vi.fn().mockRejectedValue(new Error("selector missed")),
    });
    const t = new CdpBrowserTransport({ pageFactory: async () => page });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "click",
      params: { selector: ".missing" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.reason).toMatch(/selector missed/);
      expect(res.error.transport).toBe("cdp-browser");
    }
  });

  it("unknown action returns err envelope", async () => {
    const page = makeMockPage();
    const t = new CdpBrowserTransport({ pageFactory: async () => page });
    await t.open(makeCtx());
    const res = await t.action({ kind: "not_a_real_step", params: {} });
    expect(res.ok).toBe(false);
  });

  it("snapshot(format: screenshot) delegates to IPage.screenshot", async () => {
    const page = makeMockPage();
    const t = new CdpBrowserTransport({ pageFactory: async () => page });
    await t.open(makeCtx());
    const snap = await t.snapshot({ format: "screenshot" });
    expect(snap.format).toBe("screenshot");
    expect(page.screenshot).toHaveBeenCalled();
  });

  it("snapshot(format: dom-ax) delegates to IPage.snapshot", async () => {
    const page = makeMockPage();
    const t = new CdpBrowserTransport({ pageFactory: async () => page });
    await t.open(makeCtx());
    const snap = await t.snapshot({ format: "dom-ax" });
    expect(snap.format).toBe("dom-ax");
    expect(page.snapshot).toHaveBeenCalled();
  });

  it("snapshot(format: compact) encodes DOM refs for later CDP clicks", async () => {
    const page = makeMockPage({
      evaluate: vi.fn().mockResolvedValue({
        role: "document",
        name: "Editor",
        path: "document[0]",
        scope: "renderer",
        children: [
          {
            role: "button",
            name: "Run",
            path: "#run",
            scope: "renderer",
            states: ["focusable"],
          },
        ],
      }),
    });
    const bus = createTransportBus();
    const t = new CdpBrowserTransport({ pageFactory: async () => page });
    await t.open({ vars: {}, bus, refs: bus.refs });

    const snap = await t.snapshot({ format: "compact" });
    const runRef = bus.refs
      .list()
      .find((ref) => ref.stable === "cdp-browser:renderer:#run");
    const clicked = await t.action({
      kind: "click",
      params: { stable: runRef?.stable },
    });

    expect(snap).toMatchObject({
      format: "text",
      encoding: "compact",
      refs: { count: 2, scope: "renderer" },
    });
    expect(String(snap.data)).toContain('@e2 button "Run"');
    expect(runRef).toMatchObject({ role: "button", name: "Run" });
    expect(clicked.ok).toBe(true);
    expect(page.click).toHaveBeenCalledWith("#run");
  });

  it("type can use a stable CDP ref selector", async () => {
    const page = makeMockPage();
    const t = new CdpBrowserTransport({ pageFactory: async () => page });
    await t.open(makeCtx());

    const typed = await t.action({
      kind: "type",
      params: {
        stable: "cdp-browser:renderer:#name",
        text: "Ada",
      },
    });

    expect(typed.ok).toBe(true);
    expect(page.type).toHaveBeenCalledWith("#name", "Ada");
  });

  it("close releases the page", async () => {
    const page = makeMockPage();
    const t = new CdpBrowserTransport({ pageFactory: async () => page });
    await t.open(makeCtx());
    await t.close();
    expect(page.close).toHaveBeenCalled();
    // Second close is a no-op — must not throw.
    await t.close();
  });
});
