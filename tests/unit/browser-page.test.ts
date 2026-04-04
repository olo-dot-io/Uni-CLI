/**
 * Unit tests for BrowserPage -- mocks CDPClient to verify correct CDP commands.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { BrowserPage } from "../../src/browser/page.js";

// ── Mock CDPClient ──────────────────────────────────────────────────

interface RecordedCall {
  method: string;
  params: Record<string, unknown> | undefined;
}

class MockCDPClient {
  calls: RecordedCall[] = [];
  responses = new Map<string, unknown>();
  listeners = new Map<string, Set<(params: unknown) => void>>();

  async send(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    this.calls.push({ method, params });
    return this.responses.get(method) ?? {};
  }

  on(event: string, handler: (params: unknown) => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
  }

  off(event: string, handler: (params: unknown) => void): void {
    this.listeners.get(event)?.delete(handler);
  }

  async close(): Promise<void> {
    // no-op for mock
  }

  /** Simulate firing a CDP event */
  fireEvent(event: string, params?: unknown): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const handler of set) {
        handler(params);
      }
    }
  }
}

// ── Helper ──────────────────────────────────────────────────────────

function createPage(): { page: BrowserPage; mock: MockCDPClient } {
  const mock = new MockCDPClient();
  // Cast mock as CDPClient -- the mock has the same shape for what BrowserPage uses
  const page = new BrowserPage(mock as never);
  return { page, mock };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("BrowserPage", () => {
  let page: BrowserPage;
  let mock: MockCDPClient;

  beforeEach(() => {
    const result = createPage();
    page = result.page;
    mock = result.mock;
  });

  describe("evaluate()", () => {
    it("sends Runtime.evaluate with correct params and returns value", async () => {
      mock.responses.set("Runtime.evaluate", {
        result: { value: 42 },
      });

      const result = await page.evaluate("1 + 1");

      expect(result).toBe(42);
      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0].method).toBe("Runtime.evaluate");
      expect(mock.calls[0].params).toEqual({
        expression: "1 + 1",
        returnByValue: true,
        awaitPromise: true,
        allowUnsafeEvalBlockedByCSP: true,
      });
    });

    it("throws on exceptionDetails with exception description", async () => {
      mock.responses.set("Runtime.evaluate", {
        exceptionDetails: {
          exception: { description: "ReferenceError: foo is not defined" },
        },
      });

      await expect(page.evaluate("foo")).rejects.toThrow(
        "Evaluate error: ReferenceError: foo is not defined",
      );
    });

    it("throws on exceptionDetails with text fallback", async () => {
      mock.responses.set("Runtime.evaluate", {
        exceptionDetails: {
          text: "Uncaught",
        },
      });

      await expect(page.evaluate("bad()")).rejects.toThrow(
        "Evaluate error: Uncaught",
      );
    });

    it("returns undefined when result has no value", async () => {
      mock.responses.set("Runtime.evaluate", {
        result: {},
      });

      const result = await page.evaluate("void 0");
      expect(result).toBeUndefined();
    });
  });

  describe("goto()", () => {
    it("calls Page.navigate and waits for load event", async () => {
      mock.responses.set("Page.navigate", { frameId: "abc" });

      // Fire load event after a microtask to simulate async page load
      const gotoPromise = page.goto("https://example.com");

      // The page should have registered a listener; fire the event
      // Use setTimeout to fire after the navigate call
      setTimeout(() => mock.fireEvent("Page.loadEventFired"), 10);

      await gotoPromise;

      const navigateCall = mock.calls.find((c) => c.method === "Page.navigate");
      expect(navigateCall).toBeDefined();
      expect(navigateCall!.params).toEqual({ url: "https://example.com" });
    });

    it("throws when navigation returns errorText", async () => {
      mock.responses.set("Page.navigate", {
        errorText: "net::ERR_NAME_NOT_RESOLVED",
      });

      // Fire load event so the load promise resolves (goto checks error before waiting)
      setTimeout(() => mock.fireEvent("Page.loadEventFired"), 5);

      await expect(page.goto("https://invalid.test")).rejects.toThrow(
        "Navigation failed: net::ERR_NAME_NOT_RESOLVED",
      );
    });

    it("respects settleMs option", async () => {
      mock.responses.set("Page.navigate", { frameId: "abc" });

      const start = Date.now();
      setTimeout(() => mock.fireEvent("Page.loadEventFired"), 5);

      await page.goto("https://example.com", { settleMs: 100 });

      const elapsed = Date.now() - start;
      // Should have waited at least ~100ms for settle
      expect(elapsed).toBeGreaterThanOrEqual(90);
    });
  });

  describe("click()", () => {
    it("falls back to JS click when DOM methods fail", async () => {
      // Make DOM.getDocument throw to trigger fallback
      const originalSend = mock.send.bind(mock);
      mock.send = async (
        method: string,
        params?: Record<string, unknown>,
      ): Promise<unknown> => {
        if (method === "DOM.getDocument") {
          throw new Error("DOM not available");
        }
        // For the JS fallback evaluate call, return success
        if (method === "Runtime.evaluate") {
          mock.calls.push({ method, params });
          return { result: { value: undefined } };
        }
        return originalSend(method, params);
      };

      await page.click("#btn");

      // Should have attempted DOM.getDocument, then fallen back to evaluate
      const evaluateCall = mock.calls.find(
        (c) => c.method === "Runtime.evaluate",
      );
      expect(evaluateCall).toBeDefined();
      // The expression should contain querySelector with our selector
      const expr = evaluateCall!.params?.expression as string;
      expect(expr).toContain("document.querySelector");
      expect(expr).toContain("#btn");
    });

    it("uses CDP native click when DOM methods succeed", async () => {
      mock.responses.set("DOM.getDocument", {
        root: { nodeId: 1 },
      });
      mock.responses.set("DOM.querySelector", { nodeId: 5 });
      mock.responses.set("DOM.getBoxModel", {
        model: {
          // Rectangle at (100,100)-(200,200)
          content: [100, 100, 200, 100, 200, 200, 100, 200],
        },
      });

      await page.click(".target");

      const mousePressed = mock.calls.find(
        (c) =>
          c.method === "Input.dispatchMouseEvent" &&
          c.params?.type === "mousePressed",
      );
      const mouseReleased = mock.calls.find(
        (c) =>
          c.method === "Input.dispatchMouseEvent" &&
          c.params?.type === "mouseReleased",
      );

      expect(mousePressed).toBeDefined();
      expect(mouseReleased).toBeDefined();
      // Center of the box: (150, 150)
      expect(mousePressed!.params?.x).toBe(150);
      expect(mousePressed!.params?.y).toBe(150);
      expect(mousePressed!.params?.button).toBe("left");
    });

    it("falls back to JS click when nodeId is 0 (not found)", async () => {
      mock.responses.set("DOM.getDocument", {
        root: { nodeId: 1 },
      });
      mock.responses.set("DOM.querySelector", { nodeId: 0 });
      // evaluate for JS fallback
      mock.responses.set("Runtime.evaluate", {
        result: { value: undefined },
      });

      await page.click(".missing");

      // Should have fallen back to evaluate
      const evaluateCall = mock.calls.find(
        (c) => c.method === "Runtime.evaluate",
      );
      expect(evaluateCall).toBeDefined();
    });
  });

  describe("type()", () => {
    it("clicks selector then calls Input.insertText", async () => {
      // Set up DOM mocks for the click
      mock.responses.set("DOM.getDocument", {
        root: { nodeId: 1 },
      });
      mock.responses.set("DOM.querySelector", { nodeId: 3 });
      mock.responses.set("DOM.getBoxModel", {
        model: { content: [0, 0, 100, 0, 100, 50, 0, 50] },
      });

      await page.type("input#name", "hello");

      const insertCall = mock.calls.find(
        (c) => c.method === "Input.insertText",
      );
      expect(insertCall).toBeDefined();
      expect(insertCall!.params).toEqual({ text: "hello" });
    });
  });

  describe("press()", () => {
    it("sends keyDown + keyUp events for Enter", async () => {
      await page.press("Enter");

      const keyDown = mock.calls.find(
        (c) =>
          c.method === "Input.dispatchKeyEvent" && c.params?.type === "keyDown",
      );
      const keyUp = mock.calls.find(
        (c) =>
          c.method === "Input.dispatchKeyEvent" && c.params?.type === "keyUp",
      );

      expect(keyDown).toBeDefined();
      expect(keyUp).toBeDefined();
      expect(keyDown!.params?.key).toBe("Enter");
      expect(keyDown!.params?.code).toBe("Enter");
      expect(keyDown!.params?.windowsVirtualKeyCode).toBe(13);
    });

    it("passes through unknown keys directly", async () => {
      await page.press("a");

      const keyDown = mock.calls.find(
        (c) =>
          c.method === "Input.dispatchKeyEvent" && c.params?.type === "keyDown",
      );
      expect(keyDown!.params?.key).toBe("a");
      expect(keyDown!.params?.code).toBe("a");
    });
  });

  describe("wait()", () => {
    it("resolves after the specified number of seconds", async () => {
      const start = Date.now();
      await page.wait(0.1); // 100ms
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(80);
    });
  });

  describe("waitForSelector()", () => {
    it("resolves immediately when element exists", async () => {
      mock.responses.set("Runtime.evaluate", {
        result: { value: true },
      });

      await page.waitForSelector(".exists");
      // Should have only polled once
      const evaluateCalls = mock.calls.filter(
        (c) => c.method === "Runtime.evaluate",
      );
      expect(evaluateCalls.length).toBe(1);
    });

    it("times out when element never appears", async () => {
      mock.responses.set("Runtime.evaluate", {
        result: { value: false },
      });

      await expect(page.waitForSelector(".never", 500)).rejects.toThrow(
        "waitForSelector timed out after 500ms",
      );
    });
  });

  describe("cookies()", () => {
    it("returns formatted cookie record", async () => {
      mock.responses.set("Network.getCookies", {
        cookies: [
          { name: "session", value: "abc123", domain: ".example.com" },
          { name: "theme", value: "dark", domain: ".example.com" },
        ],
      });

      const result = await page.cookies();

      expect(result).toEqual({
        session: "abc123",
        theme: "dark",
      });
    });

    it("returns empty object when no cookies", async () => {
      mock.responses.set("Network.getCookies", { cookies: [] });

      const result = await page.cookies();
      expect(result).toEqual({});
    });

    it("handles missing cookies array gracefully", async () => {
      mock.responses.set("Network.getCookies", {});

      const result = await page.cookies();
      expect(result).toEqual({});
    });
  });

  describe("scroll()", () => {
    it("evaluates scrollBy for 'down'", async () => {
      mock.responses.set("Runtime.evaluate", { result: { value: undefined } });

      await page.scroll("down");

      const call = mock.calls.find((c) => c.method === "Runtime.evaluate");
      expect(call).toBeDefined();
      expect(call!.params?.expression).toBe(
        "window.scrollBy(0, window.innerHeight)",
      );
    });

    it("evaluates scrollBy for 'up'", async () => {
      mock.responses.set("Runtime.evaluate", { result: { value: undefined } });

      await page.scroll("up");

      const call = mock.calls.find((c) => c.method === "Runtime.evaluate");
      expect(call!.params?.expression).toBe(
        "window.scrollBy(0, -window.innerHeight)",
      );
    });

    it("evaluates scrollTo for 'bottom'", async () => {
      mock.responses.set("Runtime.evaluate", { result: { value: undefined } });

      await page.scroll("bottom");

      const call = mock.calls.find((c) => c.method === "Runtime.evaluate");
      expect(call!.params?.expression).toBe(
        "window.scrollTo(0, document.body.scrollHeight)",
      );
    });

    it("evaluates scrollTo for 'top'", async () => {
      mock.responses.set("Runtime.evaluate", { result: { value: undefined } });

      await page.scroll("top");

      const call = mock.calls.find((c) => c.method === "Runtime.evaluate");
      expect(call!.params?.expression).toBe("window.scrollTo(0, 0)");
    });
  });

  describe("title()", () => {
    it("returns document.title via evaluate", async () => {
      mock.responses.set("Runtime.evaluate", {
        result: { value: "My Page" },
      });

      const result = await page.title();
      expect(result).toBe("My Page");
    });
  });

  describe("url()", () => {
    it("returns window.location.href via evaluate", async () => {
      mock.responses.set("Runtime.evaluate", {
        result: { value: "https://example.com/path" },
      });

      const result = await page.url();
      expect(result).toBe("https://example.com/path");
    });
  });

  describe("addInitScript()", () => {
    it("sends Page.addScriptToEvaluateOnNewDocument", async () => {
      await page.addInitScript("console.log('stealth')");

      expect(mock.calls[0].method).toBe(
        "Page.addScriptToEvaluateOnNewDocument",
      );
      expect(mock.calls[0].params).toEqual({
        source: "console.log('stealth')",
      });
    });
  });

  describe("close()", () => {
    it("calls client.close()", async () => {
      const closeSpy = vi.spyOn(mock, "close");
      await page.close();
      expect(closeSpy).toHaveBeenCalledOnce();
    });
  });
});
