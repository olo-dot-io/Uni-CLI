/**
 * CdpBrowserTransport adapter tests.
 *
 * CdpBrowserTransport wraps the existing `BrowserPage` (IPage impl) behind
 * the TransportAdapter interface. For unit testing we inject a mock IPage
 * so we don't need a live Chrome at test time.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserInvocationContext } from "../../../../src/browser/invocation-context.js";
import {
  createBrowserInvocationScope,
  runBrowserInvocation,
} from "../../../../src/browser/invocation-scope.js";
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

  it("attaches to the requested renderer instead of the probe default", async () => {
    const page = makeMockPage();
    const targets = [
      {
        id: "page-a",
        type: "page",
        title: "First",
        url: "app://first",
        webSocketDebuggerUrl: "ws://127.0.0.1:9333/page-a",
      },
      {
        id: "page-b",
        type: "page",
        title: "Second",
        url: "app://second",
        webSocketDebuggerUrl: "ws://127.0.0.1:9333/page-b",
      },
    ];
    const pageConnector = vi.fn().mockResolvedValue(page);
    const transport = new CdpBrowserTransport({
      pageFactory: async () => {
        throw new Error("an exact target must not use the default page");
      },
      pageConnector,
      cdpProbe: vi.fn().mockResolvedValue({
        port: 9333,
        webSocketDebuggerUrl: targets[0]!.webSocketDebuggerUrl,
        targets,
      }),
    });
    await transport.open(makeCtx());

    const attached = await transport.action({
      kind: "cdp_attach",
      params: { port: 9333, targetId: "page-b" },
    });

    expect(attached).toMatchObject({
      ok: true,
      data: {
        targetId: "page-b",
        webSocketDebuggerUrl: "ws://127.0.0.1:9333/page-b",
      },
    });
    expect(pageConnector).toHaveBeenCalledWith(
      9333,
      "ws://127.0.0.1:9333/page-b",
    );
  });

  it("fails closed when an exact renderer target no longer exists", async () => {
    const transport = new CdpBrowserTransport({
      pageConnector: vi.fn(),
      cdpProbe: vi.fn().mockResolvedValue({
        port: 9333,
        webSocketDebuggerUrl: "ws://127.0.0.1:9333/page-a",
        targets: [],
      }),
    });
    await transport.open(makeCtx());

    const attached = await transport.action({
      kind: "cdp_attach",
      params: { port: 9333, targetId: "missing" },
    });

    expect(attached).toMatchObject({
      ok: false,
      error: {
        minimum_capability: "cdp-browser.cdp_attach.target_not_found",
        exit_code: 66,
      },
    });
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

  it("captures a snapshot from the explicit CDP endpoint instead of the default page", async () => {
    const page = makeMockPage({
      snapshot: vi.fn().mockResolvedValue("attached renderer"),
    });
    const pageConnector = vi.fn().mockResolvedValue(page);
    const t = new CdpBrowserTransport({
      pageFactory: async () => {
        throw new Error("targeted snapshots must not use the default page");
      },
      pageConnector,
      cdpProbe: vi.fn(),
    });
    await t.open(makeCtx());

    const snapshot = await t.snapshot({
      format: "dom-ax",
      params: {
        port: 9240,
        webSocketDebuggerUrl: "ws://127.0.0.1:9240/page-1",
      },
    });

    expect(snapshot).toEqual({ format: "dom-ax", data: "attached renderer" });
    expect(pageConnector).toHaveBeenCalledWith(
      9240,
      "ws://127.0.0.1:9240/page-1",
    );
  });

  it("uses a WebSocket-only endpoint instead of silently opening the default page", async () => {
    const page = makeMockPage({
      snapshot: vi.fn().mockResolvedValue("attached renderer"),
    });
    const pageConnector = vi.fn().mockResolvedValue(page);
    const t = new CdpBrowserTransport({
      pageFactory: async () => {
        throw new Error(
          "WebSocket-only snapshots must not use the default page",
        );
      },
      pageConnector,
      cdpProbe: vi.fn(),
    });
    await t.open(makeCtx());

    const snapshot = await t.snapshot({
      format: "dom-ax",
      params: {
        webSocketDebuggerUrl: "ws://127.0.0.1:9444/devtools/page/target-1",
      },
    });

    expect(snapshot).toEqual({ format: "dom-ax", data: "attached renderer" });
    expect(pageConnector).toHaveBeenCalledWith(
      9444,
      "ws://127.0.0.1:9444/devtools/page/target-1",
    );
  });

  it("resolves a port-only target to an exact renderer before allocating refs", async () => {
    const bus = createTransportBus();
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
          },
        ],
      }),
    });
    const pageConnector = vi.fn().mockResolvedValue(page);
    const cdpProbe = vi.fn().mockResolvedValue({
      port: 9333,
      webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/resolved-target",
      targets: [],
    });
    const t = new CdpBrowserTransport({
      pageFactory: async () => {
        throw new Error("explicit snapshots must not use the default page");
      },
      pageConnector,
      cdpProbe,
    });
    await t.open({ vars: {}, bus, refs: bus.refs });

    await t.snapshot({ format: "json", params: { port: 9333 } });

    expect(cdpProbe).toHaveBeenCalledWith(9333, undefined);
    expect(pageConnector).toHaveBeenCalledWith(
      9333,
      "ws://127.0.0.1:9333/devtools/page/resolved-target",
    );
    const scope = String(bus.refs.buckets()[0]?.scope);
    expect(scope).toMatch(/^renderer-[a-f0-9]{16}$/);
    expect(bus.refs.resolveStable(`cdp-browser:${scope}:#run`)).toMatchObject({
      cdpEndpoint: {
        port: 9333,
        webSocketDebuggerUrl:
          "ws://127.0.0.1:9333/devtools/page/resolved-target",
      },
    });
  });

  it("replaces an explicit endpoint instead of silently controlling the previous port", async () => {
    const firstPage = makeMockPage({
      evaluate: vi.fn().mockResolvedValue("first"),
    });
    const secondPage = makeMockPage({
      evaluate: vi.fn().mockResolvedValue("second"),
    });
    const pageConnector = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);
    const transport = new CdpBrowserTransport({
      pageFactory: async () => {
        throw new Error("explicit endpoints must not use the default page");
      },
      pageConnector,
      cdpProbe: vi.fn(),
    });
    await transport.open(makeCtx());

    await transport.action({
      kind: "evaluate",
      params: {
        script: "location.href",
        port: 9222,
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/first",
      },
    });
    const switched = await transport.action<string>({
      kind: "evaluate",
      params: {
        script: "location.href",
        port: 9333,
        webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/second",
      },
    });

    expect(switched).toMatchObject({ ok: true, data: "second" });
    expect(pageConnector).toHaveBeenNthCalledWith(
      1,
      9222,
      "ws://127.0.0.1:9222/devtools/page/first",
    );
    expect(pageConnector).toHaveBeenNthCalledWith(
      2,
      9333,
      "ws://127.0.0.1:9333/devtools/page/second",
    );
    expect(firstPage.close).toHaveBeenCalledOnce();
    expect(secondPage.evaluate).toHaveBeenCalledWith("location.href");
  });

  it("keeps same-Agent explicit attachments isolated by turn and closes each at its own boundary", async () => {
    const firstPage = makeMockPage();
    const secondPage = makeMockPage();
    const pageConnector = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);
    const transport = new CdpBrowserTransport({
      pageFactory: async () => {
        throw new Error("explicit endpoints must not use the default page");
      },
      pageConnector,
      cdpProbe: vi.fn(),
    });
    await transport.open(makeCtx());
    const firstScope = createBrowserInvocationScope({
      context: createBrowserInvocationContext({
        transport: "mcp-http",
        agentSessionId: "shared-agent",
        turnId: "turn-a",
      }),
    });
    const secondScope = createBrowserInvocationScope({
      context: createBrowserInvocationContext({
        transport: "mcp-http",
        agentSessionId: "shared-agent",
        turnId: "turn-b",
      }),
    });

    await runBrowserInvocation(firstScope, async () => {
      await transport.action({
        kind: "evaluate",
        params: {
          script: "1",
          port: 9222,
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/turn-a",
        },
      });
      await runBrowserInvocation(secondScope, async () => {
        await transport.action({
          kind: "evaluate",
          params: {
            script: "2",
            port: 9333,
            webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/turn-b",
          },
        });
        expect(firstPage.close).not.toHaveBeenCalled();
        expect(secondPage.close).not.toHaveBeenCalled();
      });
      expect(firstPage.close).not.toHaveBeenCalled();
      expect(secondPage.close).toHaveBeenCalledOnce();
    });

    expect(firstPage.close).toHaveBeenCalledOnce();
    expect(secondPage.close).toHaveBeenCalledOnce();
  });

  it("marks cancellation of an unsettled page mutation outcome-ambiguous", async () => {
    const controller = new AbortController();
    const cancellation = new Error("cancel direct CDP mutation");
    const click = vi.fn(
      async (_selector: string, signal?: AbortSignal): Promise<void> => {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    );
    const page = makeMockPage({ click });
    const transport = new CdpBrowserTransport({
      pageFactory: async () => page,
    });
    await transport.open(makeCtx());
    const action = transport.action({
      kind: "click",
      params: { selector: "#submit" },
      canMutate: false,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());

    controller.abort(cancellation);

    await expect(action).rejects.toMatchObject({
      name: "OperationOutcomeAmbiguousError",
      operation: "click",
      cancellationReason: cancellation,
      outcome_ambiguous: true,
    });
    expect(click).toHaveBeenCalledWith("#submit", controller.signal);
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

  it("atomically publishes a requested screenshot path at the adapter boundary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "unicli-cdp-screenshot-"));
    const path = join(directory, "renderer.png");
    writeFileSync(path, "sentinel");
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const page = makeMockPage({
      screenshot: vi.fn().mockResolvedValue(png),
    });
    const transport = new CdpBrowserTransport({
      pageFactory: async () => page,
    });
    await transport.open(makeCtx());

    try {
      const result = await transport.action({
        kind: "screenshot",
        params: { path },
      });

      expect(result).toMatchObject({
        ok: true,
        data: { path, mime: "image/png", bytes: png.length },
      });
      expect(page.screenshot).toHaveBeenCalledWith();
      expect(readFileSync(path)).toEqual(png);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves an existing screenshot when page capture fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "unicli-cdp-screenshot-"));
    const path = join(directory, "renderer.png");
    writeFileSync(path, "sentinel");
    const page = makeMockPage({
      screenshot: vi.fn().mockRejectedValue(new Error("renderer disconnected")),
    });
    const transport = new CdpBrowserTransport({
      pageFactory: async () => page,
    });
    await transport.open(makeCtx());

    try {
      const result = await transport.action({
        kind: "screenshot",
        params: { path },
      });

      expect(result.ok).toBe(false);
      expect(readFileSync(path, "utf8")).toBe("sentinel");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
      refs: {
        count: 2,
        scope: "renderer",
        durability: "invocation",
        reusable: false,
      },
    });
    expect(String(snap.data)).toContain('@e2 button "Run"');
    expect(runRef).toMatchObject({ role: "button", name: "Run" });
    expect(clicked.ok).toBe(true);
    expect(page.click).toHaveBeenCalledWith("#run");
  });

  it("snapshot(format: json) replaces the target ref generation", async () => {
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
          },
        ],
      }),
    });
    const bus = createTransportBus();
    const pageConnector = vi.fn().mockResolvedValue(page);
    const t = new CdpBrowserTransport({
      pageFactory: async () => {
        throw new Error("explicit snapshots must not use the default page");
      },
      pageConnector,
      cdpProbe: vi.fn(),
    });
    await t.open({ vars: {}, bus, refs: bus.refs });

    const snap = await t.snapshot({
      format: "json",
      params: {
        port: 9333,
        webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/target-a",
      },
    });

    expect(snap).toMatchObject({
      format: "json",
      encoding: "json",
      refs: {
        count: 2,
        scope: expect.stringMatching(/^renderer-[a-f0-9]{16}$/),
        durability: "cross-process",
        reusable: true,
      },
    });
    expect(JSON.parse(String(snap.data))).toMatchObject({
      role: "document",
      name: "Editor",
    });
    const scope = String(snap.refs?.scope);
    expect(bus.refs.resolveStable(`cdp-browser:${scope}:#run`)).toMatchObject({
      role: "button",
      name: "Run",
      cdpEndpoint: {
        port: 9333,
        webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/target-a",
      },
    });
  });

  it("retains independent ref namespaces for two explicit renderers", async () => {
    const pageFor = (name: string) =>
      makeMockPage({
        evaluate: vi.fn().mockResolvedValue({
          role: "document",
          name,
          path: "document[0]",
          scope: "renderer",
          children: [
            {
              role: "button",
              name: `Run ${name}`,
              path: "#run",
              scope: "renderer",
            },
          ],
        }),
      });
    const first = pageFor("First");
    const second = pageFor("Second");
    const bus = createTransportBus();
    const transport = new CdpBrowserTransport({
      pageFactory: async () => {
        throw new Error("explicit renderers must not use the default page");
      },
      pageConnector: vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second),
      cdpProbe: vi.fn(),
    });
    await transport.open({ vars: {}, bus, refs: bus.refs });

    const firstSnapshot = await transport.snapshot({
      format: "json",
      params: {
        port: 9222,
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/first",
      },
    });
    const secondSnapshot = await transport.snapshot({
      format: "json",
      params: {
        port: 9333,
        webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/second",
      },
    });

    expect(firstSnapshot.refs?.scope).not.toBe(secondSnapshot.refs?.scope);
    expect(bus.refs.buckets()).toHaveLength(2);
    expect(
      bus.refs.resolveStable(
        `cdp-browser:${String(firstSnapshot.refs?.scope)}:#run`,
      )?.cdpEndpoint,
    ).toMatchObject({ port: 9222 });
    expect(
      bus.refs.resolveStable(
        `cdp-browser:${String(secondSnapshot.refs?.scope)}:#run`,
      )?.cdpEndpoint,
    ).toMatchObject({ port: 9333 });
  });

  it.each(["cdp-browser:renderer:#name", "cdp:renderer:#name"])(
    "type can use stable CDP ref selector %s",
    async (stable) => {
      const page = makeMockPage();
      const t = new CdpBrowserTransport({ pageFactory: async () => page });
      await t.open(makeCtx());

      const typed = await t.action({
        kind: "type",
        params: {
          stable,
          text: "Ada",
        },
      });

      expect(typed.ok).toBe(true);
      expect(page.type).toHaveBeenCalledWith("#name", "Ada");
    },
  );

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
