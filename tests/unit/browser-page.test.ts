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

    it("respects settleMs option by calling evaluate with DOM settle", async () => {
      mock.responses.set("Page.navigate", { frameId: "abc" });
      mock.responses.set("Runtime.evaluate", { result: { value: undefined } });

      setTimeout(() => mock.fireEvent("Page.loadEventFired"), 5);

      await page.goto("https://example.com", { settleMs: 2000 });

      // Should have called evaluate with DOM settle IIFE (not a plain setTimeout)
      const evaluateCall = mock.calls.find(
        (c) => c.method === "Runtime.evaluate",
      );
      expect(evaluateCall).toBeDefined();
      const expr = evaluateCall!.params?.expression as string;
      expect(expr).toContain("MutationObserver");
      expect(expr).toContain("2000"); // maxMs = settleMs
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

  describe("press() with modifiers", () => {
    it("includes modifier bitmask when modifiers provided", async () => {
      await page.press("a", ["ctrl", "shift"]);

      const keyDown = mock.calls.find(
        (c) =>
          c.method === "Input.dispatchKeyEvent" && c.params?.type === "keyDown",
      );
      expect(keyDown).toBeDefined();
      // ctrl=2, shift=8 => 10
      expect(keyDown!.params?.modifiers).toBe(10);
      expect(keyDown!.params?.key).toBe("a");
    });

    it("omits modifiers field when no modifiers given", async () => {
      await page.press("Enter");

      const keyDown = mock.calls.find(
        (c) =>
          c.method === "Input.dispatchKeyEvent" && c.params?.type === "keyDown",
      );
      expect(keyDown!.params?.modifiers).toBeUndefined();
    });
  });

  describe("insertText()", () => {
    it("sends Input.insertText with text", async () => {
      await page.insertText("hello world");

      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0].method).toBe("Input.insertText");
      expect(mock.calls[0].params).toEqual({ text: "hello world" });
    });
  });

  describe("nativeClick()", () => {
    it("sends mousePressed + mouseReleased at coordinates", async () => {
      await page.nativeClick(100, 200);

      expect(mock.calls).toHaveLength(2);
      const pressed = mock.calls[0];
      const released = mock.calls[1];

      expect(pressed.method).toBe("Input.dispatchMouseEvent");
      expect(pressed.params?.type).toBe("mousePressed");
      expect(pressed.params?.x).toBe(100);
      expect(pressed.params?.y).toBe(200);

      expect(released.method).toBe("Input.dispatchMouseEvent");
      expect(released.params?.type).toBe("mouseReleased");
      expect(released.params?.x).toBe(100);
      expect(released.params?.y).toBe(200);
    });
  });

  describe("nativeKeyPress()", () => {
    it("sends keyDown + keyUp with char code for single char", async () => {
      await page.nativeKeyPress("a");

      const keyDown = mock.calls.find(
        (c) =>
          c.method === "Input.dispatchKeyEvent" && c.params?.type === "keyDown",
      );
      expect(keyDown).toBeDefined();
      expect(keyDown!.params?.key).toBe("a");
      expect(keyDown!.params?.text).toBe("a");
      expect(keyDown!.params?.windowsVirtualKeyCode).toBe(97); // 'a'.charCodeAt(0)
    });

    it("applies modifier bitmask", async () => {
      await page.nativeKeyPress("c", ["meta"]);

      const keyDown = mock.calls.find(
        (c) =>
          c.method === "Input.dispatchKeyEvent" && c.params?.type === "keyDown",
      );
      expect(keyDown!.params?.modifiers).toBe(4); // meta=4
      // text should not be set when modifiers present
      expect(keyDown!.params?.text).toBeUndefined();
    });

    it("uses KEY_MAP for named keys", async () => {
      await page.nativeKeyPress("Enter");

      const keyDown = mock.calls.find(
        (c) =>
          c.method === "Input.dispatchKeyEvent" && c.params?.type === "keyDown",
      );
      expect(keyDown!.params?.key).toBe("Enter");
      expect(keyDown!.params?.windowsVirtualKeyCode).toBe(13);
    });
  });

  describe("setFileInput()", () => {
    it("sends DOM.setFileInputFiles for matching element", async () => {
      mock.responses.set("DOM.getDocument", { root: { nodeId: 1 } });
      mock.responses.set("DOM.querySelector", { nodeId: 7 });

      await page.setFileInput('input[type="file"]', ["/tmp/a.jpg"]);

      const setFiles = mock.calls.find(
        (c) => c.method === "DOM.setFileInputFiles",
      );
      expect(setFiles).toBeDefined();
      expect(setFiles!.params).toEqual({
        nodeId: 7,
        files: ["/tmp/a.jpg"],
      });
    });

    it("throws when element not found (nodeId=0)", async () => {
      mock.responses.set("DOM.getDocument", { root: { nodeId: 1 } });
      mock.responses.set("DOM.querySelector", { nodeId: 0 });

      await expect(
        page.setFileInput("#missing", ["/tmp/a.jpg"]),
      ).rejects.toThrow("setFileInput: element not found: #missing");
    });
  });

  describe("autoScroll()", () => {
    it("stops when page reaches bottom", async () => {
      let callCount = 0;
      const originalSend = mock.send.bind(mock);
      mock.send = async (
        method: string,
        params?: Record<string, unknown>,
      ): Promise<unknown> => {
        if (method === "Runtime.evaluate") {
          callCount++;
          mock.calls.push({ method, params });
          const expr = params?.expression as string;
          // First evaluate = scrollBy, second = check atBottom
          if (expr.includes("scrollY")) {
            return { result: { value: true } }; // at bottom immediately
          }
          return { result: { value: undefined } };
        }
        return originalSend(method, params);
      };

      await page.autoScroll({ maxScrolls: 5, delay: 10 });

      // Should have scrolled once + checked once = 2 evaluate calls
      const evalCalls = mock.calls.filter(
        (c) => c.method === "Runtime.evaluate",
      );
      expect(evalCalls.length).toBe(2);
    });
  });

  describe("screenshot()", () => {
    it("sends Page.captureScreenshot and returns Buffer", async () => {
      const testData = Buffer.from("fake-png").toString("base64");
      mock.responses.set("Page.captureScreenshot", { data: testData });

      const result = await page.screenshot();

      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.toString()).toBe("fake-png");

      const captureCall = mock.calls.find(
        (c) => c.method === "Page.captureScreenshot",
      );
      expect(captureCall!.params?.format).toBe("png");
    });

    it("passes quality for jpeg format", async () => {
      const testData = Buffer.from("fake-jpg").toString("base64");
      mock.responses.set("Page.captureScreenshot", { data: testData });

      await page.screenshot({ format: "jpeg", quality: 80 });

      const captureCall = mock.calls.find(
        (c) => c.method === "Page.captureScreenshot",
      );
      expect(captureCall!.params?.quality).toBe(80);
      expect(captureCall!.params?.format).toBe("jpeg");
    });

    it("computes full page clip dimensions", async () => {
      mock.responses.set("Runtime.evaluate", {
        result: { value: '{"width":1200,"height":5000}' },
      });
      const testData = Buffer.from("full").toString("base64");
      mock.responses.set("Page.captureScreenshot", { data: testData });

      await page.screenshot({ fullPage: true });

      const captureCall = mock.calls.find(
        (c) => c.method === "Page.captureScreenshot",
      );
      expect(captureCall!.params?.clip).toEqual({
        x: 0,
        y: 0,
        width: 1200,
        height: 5000,
        scale: 1,
      });
    });
  });

  describe("networkRequests()", () => {
    it("enables Network domain on first call", async () => {
      const result = await page.networkRequests();

      expect(result).toEqual([]);
      const enableCall = mock.calls.find((c) => c.method === "Network.enable");
      expect(enableCall).toBeDefined();
    });

    it("does not re-enable Network on subsequent calls", async () => {
      await page.networkRequests();
      mock.calls = [];

      await page.networkRequests();

      const enableCalls = mock.calls.filter(
        (c) => c.method === "Network.enable",
      );
      expect(enableCalls).toHaveLength(0);
    });

    it("accumulates events from Network.responseReceived", async () => {
      await page.networkRequests();

      // Simulate a network response event
      mock.fireEvent("Network.responseReceived", {
        response: {
          url: "https://api.example.com/data",
          status: 200,
          mimeType: "application/json",
          headers: { "content-length": "1024" },
        },
        type: "XHR",
        timestamp: 12345.67,
      });

      const result = await page.networkRequests();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        url: "https://api.example.com/data",
        method: "GET",
        status: 200,
        type: "XHR",
        size: 1024,
        timestamp: 12345.67,
      });
    });
  });

  describe("closeWindow()", () => {
    it("sends Browser.close", async () => {
      await page.closeWindow();

      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0].method).toBe("Browser.close");
    });

    it("does not throw when Browser.close fails", async () => {
      const originalSend = mock.send.bind(mock);
      mock.send = async (
        method: string,
        params?: Record<string, unknown>,
      ): Promise<unknown> => {
        if (method === "Browser.close") {
          throw new Error("Browser already closed");
        }
        return originalSend(method, params);
      };

      // Should not throw
      await expect(page.closeWindow()).resolves.toBeUndefined();
    });
  });

  describe("goto() with DOM settle", () => {
    it("uses DOM settle via evaluate when settleMs is provided", async () => {
      mock.responses.set("Page.navigate", { frameId: "abc" });
      // The evaluate call for DOM settle should return (promise resolves)
      mock.responses.set("Runtime.evaluate", { result: { value: undefined } });

      setTimeout(() => mock.fireEvent("Page.loadEventFired"), 5);
      await page.goto("https://example.com", { settleMs: 1000 });

      // Should have called evaluate with the DOM settle IIFE
      const evaluateCall = mock.calls.find(
        (c) => c.method === "Runtime.evaluate",
      );
      expect(evaluateCall).toBeDefined();
      const expr = evaluateCall!.params?.expression as string;
      expect(expr).toContain("MutationObserver");
      expect(expr).toContain("1000"); // maxMs
      expect(expr).toContain("500"); // quietMs = min(1000, 500)
    });

    it("falls back to setTimeout when evaluate throws", async () => {
      mock.responses.set("Page.navigate", { frameId: "abc" });

      // Make evaluate throw to trigger fallback
      const originalSend = mock.send.bind(mock);
      mock.send = async (
        method: string,
        params?: Record<string, unknown>,
      ): Promise<unknown> => {
        if (method === "Runtime.evaluate") {
          mock.calls.push({ method, params });
          throw new Error("Evaluate failed on about:blank");
        }
        return originalSend(method, params);
      };

      const start = Date.now();
      setTimeout(() => mock.fireEvent("Page.loadEventFired"), 5);
      await page.goto("https://example.com", { settleMs: 100 });
      const elapsed = Date.now() - start;

      // Should have waited ~100ms via the fallback setTimeout
      expect(elapsed).toBeGreaterThanOrEqual(80);
    });

    it("skips settle when settleMs is 0", async () => {
      mock.responses.set("Page.navigate", { frameId: "abc" });

      setTimeout(() => mock.fireEvent("Page.loadEventFired"), 5);
      await page.goto("https://example.com", { settleMs: 0 });

      // No evaluate call should have been made
      const evaluateCall = mock.calls.find(
        (c) => c.method === "Runtime.evaluate",
      );
      expect(evaluateCall).toBeUndefined();
    });
  });

  describe("startNetworkCapture() + readNetworkCapture()", () => {
    it("enables Network domain and sets up listeners", async () => {
      await page.startNetworkCapture();

      const enableCall = mock.calls.find((c) => c.method === "Network.enable");
      expect(enableCall).toBeDefined();

      // Should have registered listeners
      expect(mock.listeners.has("Network.requestWillBeSent")).toBe(true);
      expect(mock.listeners.has("Network.responseReceived")).toBe(true);
      expect(mock.listeners.has("Network.loadingFinished")).toBe(true);
    });

    it("does not re-enable on second call", async () => {
      await page.startNetworkCapture();
      mock.calls = [];
      await page.startNetworkCapture();

      const enableCalls = mock.calls.filter(
        (c) => c.method === "Network.enable",
      );
      expect(enableCalls).toHaveLength(0);
    });

    it("captures responses matching substring pattern", async () => {
      // Set up getResponseBody response
      mock.responses.set("Network.getResponseBody", {
        body: '{"items":[1,2,3]}',
        base64Encoded: false,
      });

      await page.startNetworkCapture("api.example.com");

      // Simulate request
      mock.fireEvent("Network.requestWillBeSent", {
        requestId: "req-1",
        request: { url: "https://api.example.com/data", method: "POST" },
      });

      // Simulate response
      mock.fireEvent("Network.responseReceived", {
        requestId: "req-1",
        response: {
          url: "https://api.example.com/data",
          status: 200,
          mimeType: "application/json",
          headers: { "content-length": "512" },
        },
        type: "XHR",
        timestamp: 99999,
      });

      // Simulate loading finished
      mock.fireEvent("Network.loadingFinished", {
        requestId: "req-1",
        encodedDataLength: 512,
      });

      // Allow the async getResponseBody promise to settle
      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      const entries = await page.readNetworkCapture();
      expect(entries).toHaveLength(1);
      expect(entries[0].url).toBe("https://api.example.com/data");
      expect(entries[0].method).toBe("POST");
      expect(entries[0].status).toBe(200);
      expect(entries[0].contentType).toBe("application/json");
      expect(entries[0].responseBody).toBe('{"items":[1,2,3]}');
      expect(entries[0].size).toBe(512);
    });

    it("filters out non-matching URLs", async () => {
      await page.startNetworkCapture("api.example.com");

      mock.fireEvent("Network.requestWillBeSent", {
        requestId: "req-1",
        request: { url: "https://cdn.other.com/style.css", method: "GET" },
      });

      mock.fireEvent("Network.responseReceived", {
        requestId: "req-1",
        response: {
          url: "https://cdn.other.com/style.css",
          status: 200,
          mimeType: "text/css",
        },
        type: "Stylesheet",
        timestamp: 1000,
      });

      const entries = await page.readNetworkCapture();
      expect(entries).toHaveLength(0);
    });

    it("supports regex pattern via /pattern/ syntax", async () => {
      mock.responses.set("Network.getResponseBody", {
        body: "ok",
        base64Encoded: false,
      });

      await page.startNetworkCapture("/\\.json$/");

      mock.fireEvent("Network.requestWillBeSent", {
        requestId: "req-1",
        request: { url: "https://api.example.com/data.json", method: "GET" },
      });
      mock.fireEvent("Network.responseReceived", {
        requestId: "req-1",
        response: {
          url: "https://api.example.com/data.json",
          status: 200,
          mimeType: "application/json",
        },
        timestamp: 1000,
      });
      mock.fireEvent("Network.loadingFinished", { requestId: "req-1" });

      mock.fireEvent("Network.requestWillBeSent", {
        requestId: "req-2",
        request: { url: "https://api.example.com/data.xml", method: "GET" },
      });
      mock.fireEvent("Network.responseReceived", {
        requestId: "req-2",
        response: {
          url: "https://api.example.com/data.xml",
          status: 200,
          mimeType: "text/xml",
        },
        timestamp: 1001,
      });
      mock.fireEvent("Network.loadingFinished", { requestId: "req-2" });

      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      const entries = await page.readNetworkCapture();
      expect(entries).toHaveLength(1);
      expect(entries[0].url).toContain(".json");
    });

    it("captures all URLs when no pattern given", async () => {
      mock.responses.set("Network.getResponseBody", {
        body: "data",
        base64Encoded: false,
      });

      await page.startNetworkCapture();

      mock.fireEvent("Network.requestWillBeSent", {
        requestId: "req-1",
        request: { url: "https://anything.com/path", method: "GET" },
      });
      mock.fireEvent("Network.responseReceived", {
        requestId: "req-1",
        response: {
          url: "https://anything.com/path",
          status: 200,
          mimeType: "text/html",
        },
        timestamp: 1000,
      });

      const entries = await page.readNetworkCapture();
      expect(entries).toHaveLength(1);
    });

    it("clears buffer after readNetworkCapture()", async () => {
      await page.startNetworkCapture();

      mock.fireEvent("Network.requestWillBeSent", {
        requestId: "req-1",
        request: { url: "https://a.com", method: "GET" },
      });
      mock.fireEvent("Network.responseReceived", {
        requestId: "req-1",
        response: { url: "https://a.com", status: 200 },
        timestamp: 1000,
      });

      const first = await page.readNetworkCapture();
      expect(first).toHaveLength(1);

      const second = await page.readNetworkCapture();
      expect(second).toHaveLength(0);
    });

    it("handles base64-encoded response bodies", async () => {
      const originalBody = "Hello World";
      mock.responses.set("Network.getResponseBody", {
        body: Buffer.from(originalBody).toString("base64"),
        base64Encoded: true,
      });

      await page.startNetworkCapture();

      mock.fireEvent("Network.requestWillBeSent", {
        requestId: "req-1",
        request: { url: "https://a.com/bin", method: "GET" },
      });
      mock.fireEvent("Network.responseReceived", {
        requestId: "req-1",
        response: {
          url: "https://a.com/bin",
          status: 200,
          mimeType: "application/octet-stream",
        },
        timestamp: 1000,
      });
      mock.fireEvent("Network.loadingFinished", {
        requestId: "req-1",
        encodedDataLength: 11,
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      const entries = await page.readNetworkCapture();
      expect(entries).toHaveLength(1);
      expect(entries[0].responseBody).toBe("Hello World");
    });

    it("reuses Network.enable from networkRequests()", async () => {
      // First enable via networkRequests
      await page.networkRequests();
      mock.calls = [];

      // startNetworkCapture should NOT call Network.enable again
      await page.startNetworkCapture();

      const enableCalls = mock.calls.filter(
        (c) => c.method === "Network.enable",
      );
      expect(enableCalls).toHaveLength(0);
    });

    it("caps buffer at 100 entries", async () => {
      await page.startNetworkCapture();

      // Fire 105 responses
      for (let i = 0; i < 105; i++) {
        const id = `req-${String(i)}`;
        mock.fireEvent("Network.requestWillBeSent", {
          requestId: id,
          request: { url: `https://a.com/${String(i)}`, method: "GET" },
        });
        mock.fireEvent("Network.responseReceived", {
          requestId: id,
          response: {
            url: `https://a.com/${String(i)}`,
            status: 200,
            mimeType: "text/html",
          },
          timestamp: i,
        });
      }

      const entries = await page.readNetworkCapture();
      expect(entries.length).toBeLessThanOrEqual(100);
    });
  });
});
