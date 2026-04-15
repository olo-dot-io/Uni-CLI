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
