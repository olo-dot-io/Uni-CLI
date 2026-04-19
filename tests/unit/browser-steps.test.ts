/**
 * Browser pipeline step tests.
 *
 * Since browser steps require a live Chrome CDP connection, these tests
 * verify the step registration, step dispatch, and error behavior
 * without actually connecting to Chrome.
 */

import { describe, it, expect, vi } from "vitest";
import { runPipeline, PipelineError } from "../../src/engine/yaml-runner.js";

// Mock the browser modules so tests don't require a running Chrome
vi.mock("../../src/browser/page.js", () => {
  const mockPage = {
    goto: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue("mock-result"),
    click: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockResolvedValue(undefined),
    nativeKeyPress: vi.fn().mockResolvedValue(undefined),
    waitFor: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    scroll: vi.fn().mockResolvedValue(undefined),
    autoScroll: vi.fn().mockResolvedValue(undefined),
    snapshot: vi.fn().mockResolvedValue("mock-snapshot-tree"),
    cookies: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
    sendCDP: vi.fn().mockResolvedValue(undefined),
    nativeClick: vi.fn().mockResolvedValue(undefined),
    networkRequests: vi.fn().mockResolvedValue([]),
  };

  return {
    BrowserPage: {
      connect: vi.fn().mockResolvedValue(mockPage),
    },
    __mockPage: mockPage,
  };
});

vi.mock("../../src/browser/stealth.js", () => ({
  injectStealth: vi.fn().mockResolvedValue(undefined),
}));

// Access the mock page for assertions
async function getMockPage() {
  const mod = await import("../../src/browser/page.js");
  return (
    mod as unknown as { __mockPage: Record<string, ReturnType<typeof vi.fn>> }
  ).__mockPage;
}

describe("browser step: navigate", () => {
  it("calls page.goto with resolved URL", async () => {
    const mockPage = await getMockPage();
    const steps = [
      { navigate: { url: "https://example.com/${{ args.path }}" } },
    ];
    await runPipeline(steps, { args: { path: "search" }, source: "internal" });
    expect(mockPage.goto).toHaveBeenCalledWith("https://example.com/search", {
      settleMs: 0,
    });
  });

  it("passes settleMs option", async () => {
    const mockPage = await getMockPage();
    mockPage.goto.mockClear();
    const steps = [
      { navigate: { url: "https://example.com", settleMs: 2000 } },
    ];
    await runPipeline(steps, { args: {}, source: "internal" });
    expect(mockPage.goto).toHaveBeenCalledWith("https://example.com", {
      settleMs: 2000,
    });
  });

  it("passes waitUntil option and waits for networkidle", async () => {
    const mockPage = await getMockPage();
    mockPage.goto.mockClear();
    mockPage.networkRequests.mockClear();
    mockPage.waitFor.mockClear();
    // Simulate stable network: always return same count
    mockPage.networkRequests.mockResolvedValue([
      { url: "https://example.com" },
    ]);
    const steps = [
      {
        navigate: {
          url: "https://example.com",
          waitUntil: "networkidle",
          settleMs: 500,
        },
      },
    ];
    await runPipeline(steps, { args: {}, source: "internal" });
    expect(mockPage.goto).toHaveBeenCalledWith("https://example.com", {
      settleMs: 500,
      waitUntil: "networkidle",
    });
    // networkRequests should have been polled at least once
    expect(mockPage.networkRequests).toHaveBeenCalled();
  });
});

describe("browser step: evaluate", () => {
  it("runs expression and stores result as data", async () => {
    const mockPage = await getMockPage();
    mockPage.evaluate.mockResolvedValueOnce(42);
    const steps = [{ evaluate: { expression: "1 + 1" } }];
    const result = await runPipeline(steps, { args: {}, source: "internal" });
    expect(mockPage.evaluate).toHaveBeenCalledWith("1 + 1");
    expect(result).toEqual([42]);
  });

  it("accepts string shorthand", async () => {
    const mockPage = await getMockPage();
    mockPage.evaluate.mockResolvedValueOnce("hello");
    const steps = [{ evaluate: "document.title" }];
    const result = await runPipeline(steps, { args: {}, source: "internal" });
    expect(mockPage.evaluate).toHaveBeenCalledWith("document.title");
    expect(result).toEqual(["hello"]);
  });
});

describe("browser step: click", () => {
  it("clicks resolved selector", async () => {
    const mockPage = await getMockPage();
    const steps = [{ click: { selector: ".btn-${{ args.type }}" } }];
    await runPipeline(steps, { args: { type: "submit" }, source: "internal" });
    expect(mockPage.click).toHaveBeenCalledWith(".btn-submit");
  });

  it("accepts string shorthand", async () => {
    const mockPage = await getMockPage();
    mockPage.click.mockClear();
    const steps = [{ click: "#main-button" }];
    await runPipeline(steps, { args: {}, source: "internal" });
    expect(mockPage.click).toHaveBeenCalledWith("#main-button");
  });

  it("clicks by x/y coordinates via nativeClick", async () => {
    const mockPage = await getMockPage();
    mockPage.nativeClick.mockClear();
    const steps = [{ click: { x: 150, y: 300 } }];
    await runPipeline(steps, { args: {}, source: "internal" });
    expect(mockPage.nativeClick).toHaveBeenCalledWith(150, 300);
  });

  it("clicks by selector in object form", async () => {
    const mockPage = await getMockPage();
    mockPage.click.mockClear();
    const steps = [{ click: { selector: "#btn" } }];
    await runPipeline(steps, { args: {}, source: "internal" });
    expect(mockPage.click).toHaveBeenCalledWith("#btn");
  });

  it("throws PipelineError when neither selector nor coordinates provided", async () => {
    const steps = [{ click: {} }];
    await expect(
      runPipeline(steps, { args: {}, source: "internal" }),
    ).rejects.toThrow(PipelineError);
    await expect(
      runPipeline(steps, { args: {}, source: "internal" }),
    ).rejects.toThrow(
      /click step requires either selector or x\/y coordinates/,
    );
  });
});

describe("browser step: type", () => {
  it("types text into a selector", async () => {
    const mockPage = await getMockPage();
    const steps = [
      { type: { selector: "#search", text: "${{ args.query }}" } },
    ];
    await runPipeline(steps, {
      args: { query: "hello world" },
      source: "internal",
    });
    expect(mockPage.type).toHaveBeenCalledWith("#search", "hello world");
  });

  it("types text without selector via sendCDP", async () => {
    const mockPage = await getMockPage();
    mockPage.sendCDP.mockClear();
    const steps = [{ type: { text: "raw input" } }];
    await runPipeline(steps, { args: {}, source: "internal" });
    expect(mockPage.sendCDP).toHaveBeenCalledWith("Input.insertText", {
      text: "raw input",
    });
  });

  it("presses Enter when submit is true", async () => {
    const mockPage = await getMockPage();
    mockPage.press.mockClear();
    const steps = [
      { type: { selector: "#search", text: "query", submit: true } },
    ];
    await runPipeline(steps, { args: {}, source: "internal" });
    expect(mockPage.press).toHaveBeenCalledWith("Enter");
  });
});

describe("browser step: wait", () => {
  it("waits for a fixed number of milliseconds", async () => {
    const mockPage = await getMockPage();
    mockPage.waitFor.mockClear();
    const steps = [{ wait: 100 }];
    await runPipeline(steps, { args: {}, source: "internal" });
    expect(mockPage.waitFor).toHaveBeenCalledWith(100);
  });

  it("waits for a CSS selector", async () => {
    const mockPage = await getMockPage();
    mockPage.waitFor.mockClear();
    const steps = [{ wait: { selector: ".loaded", timeout: 5000 } }];
    await runPipeline(steps, { args: {}, source: "internal" });
    expect(mockPage.waitFor).toHaveBeenCalledWith(".loaded", 5000);
  });

  it("waits by ms property", async () => {
    const mockPage = await getMockPage();
    mockPage.waitFor.mockClear();
    const steps = [{ wait: { ms: 500 } }];
    await runPipeline(steps, { args: {}, source: "internal" });
    expect(mockPage.waitFor).toHaveBeenCalledWith(500);
  });
});

describe("browser step: intercept", () => {
  it("throws PipelineError on timeout when no request captured", async () => {
    const mockPage = await getMockPage();
    // Make evaluate return empty array for capture polling, then throw timeout
    mockPage.evaluate.mockImplementation(async (expr: string) => {
      if (typeof expr === "string" && expr.includes("__unicli_intercepted")) {
        return "[]";
      }
      return undefined;
    });

    const steps = [
      {
        intercept: {
          trigger: "scroll",
          capture: "/api/data",
          timeout: 300,
        },
      },
    ];

    await expect(
      runPipeline(steps, { args: {}, source: "internal" }),
    ).rejects.toThrow(PipelineError);
    await expect(
      runPipeline(steps, { args: {}, source: "internal" }),
    ).rejects.toThrow(/Intercept timeout/);
  });
});

describe("browser page cleanup", () => {
  it("calls page.close in finally block", async () => {
    const mockPage = await getMockPage();
    mockPage.close.mockClear();
    mockPage.evaluate.mockResolvedValueOnce("done");
    const steps = [{ evaluate: "document.title" }];
    await runPipeline(steps, { args: {}, source: "internal" });
    expect(mockPage.close).toHaveBeenCalled();
  });
});

describe("browser step: press", () => {
  it("presses a simple key string", async () => {
    const mockPage = await getMockPage();
    mockPage.press.mockClear();
    const steps = [{ press: "Enter" }];
    await runPipeline(steps, { args: {}, source: "internal" });
    expect(mockPage.press).toHaveBeenCalledWith("Enter");
  });

  it("presses a key with template substitution", async () => {
    const mockPage = await getMockPage();
    mockPage.press.mockClear();
    const steps = [{ press: "${{ args.key }}" }];
    await runPipeline(steps, { args: { key: "Tab" }, source: "internal" });
    expect(mockPage.press).toHaveBeenCalledWith("Tab");
  });

  it("presses a key with modifiers via nativeKeyPress", async () => {
    const mockPage = await getMockPage();
    mockPage.nativeKeyPress.mockClear();
    const steps = [{ press: { key: "a", modifiers: ["ctrl"] } }];
    await runPipeline(steps, { args: {}, source: "internal" });
    expect(mockPage.nativeKeyPress).toHaveBeenCalledWith("a", ["ctrl"]);
  });

  it("presses object config without modifiers via press()", async () => {
    const mockPage = await getMockPage();
    mockPage.press.mockClear();
    const steps = [{ press: { key: "Escape" } }];
    await runPipeline(steps, { args: {}, source: "internal" });
    expect(mockPage.press).toHaveBeenCalledWith("Escape");
  });
});

describe("browser step: scroll", () => {
  it("scrolls by direction string", async () => {
    const mockPage = await getMockPage();
    mockPage.scroll.mockClear();
    const steps = [{ scroll: "down" }];
    await runPipeline(steps, { args: {}, source: "internal" });
    expect(mockPage.scroll).toHaveBeenCalledWith("down");
  });

  it("scrolls to an extreme via 'to' property", async () => {
    const mockPage = await getMockPage();
    mockPage.scroll.mockClear();
    const steps = [{ scroll: { to: "bottom" } }];
    await runPipeline(steps, { args: {}, source: "internal" });
    expect(mockPage.scroll).toHaveBeenCalledWith("bottom");
  });

  it("scrolls to element via selector", async () => {
    const mockPage = await getMockPage();
    mockPage.evaluate.mockClear();
    mockPage.evaluate.mockResolvedValueOnce(undefined);
    const steps = [{ scroll: { selector: "#comments" } }];
    await runPipeline(steps, { args: {}, source: "internal" });
    expect(mockPage.evaluate).toHaveBeenCalledWith(
      expect.stringContaining("scrollIntoView"),
    );
  });

  it("auto-scrolls with max and delay", async () => {
    const mockPage = await getMockPage();
    mockPage.autoScroll.mockClear();
    const steps = [{ scroll: { auto: true, max: 10, delay: 1000 } }];
    await runPipeline(steps, { args: {}, source: "internal" });
    expect(mockPage.autoScroll).toHaveBeenCalledWith({
      maxScrolls: 10,
      delay: 1000,
    });
  });
});

describe("browser step: snapshot", () => {
  it("takes a snapshot with default options", async () => {
    const mockPage = await getMockPage();
    mockPage.snapshot.mockClear();
    mockPage.snapshot.mockResolvedValueOnce("snapshot-tree");
    const steps = [{ snapshot: {} }];
    const result = await runPipeline(steps, { args: {}, source: "internal" });
    expect(mockPage.snapshot).toHaveBeenCalledWith({
      interactive: undefined,
      compact: undefined,
      maxDepth: undefined,
      raw: undefined,
    });
    expect(result).toEqual(["snapshot-tree"]);
  });

  it("passes normalized options (max_depth -> maxDepth)", async () => {
    const mockPage = await getMockPage();
    mockPage.snapshot.mockClear();
    mockPage.snapshot.mockResolvedValueOnce("tree");
    const steps = [
      { snapshot: { interactive: true, compact: true, max_depth: 5 } },
    ];
    const result = await runPipeline(steps, { args: {}, source: "internal" });
    expect(mockPage.snapshot).toHaveBeenCalledWith({
      interactive: true,
      compact: true,
      maxDepth: 5,
      raw: undefined,
    });
    expect(result).toEqual(["tree"]);
  });
});

describe("browser step: tap", () => {
  it("evaluates a tap script and returns parsed JSON data", async () => {
    const mockPage = await getMockPage();
    mockPage.evaluate.mockClear();
    mockPage.evaluate.mockResolvedValueOnce(
      JSON.stringify({ url: "/api/user", data: { name: "test" }, ts: 123 }),
    );
    const steps = [
      {
        tap: {
          store: "userStore",
          action: "fetchData",
          capture: "/api/user",
          framework: "pinia" as const,
        },
      },
    ];
    const result = await runPipeline(steps, { args: {}, source: "internal" });
    expect(mockPage.evaluate).toHaveBeenCalledWith(
      expect.stringContaining("userStore"),
    );
    expect(mockPage.evaluate).toHaveBeenCalledWith(
      expect.stringContaining("fetchData"),
    );
    expect(result).toEqual([
      { url: "/api/user", data: { name: "test" }, ts: 123 },
    ]);
  });

  it("returns raw string when JSON.parse fails", async () => {
    const mockPage = await getMockPage();
    mockPage.evaluate.mockClear();
    mockPage.evaluate.mockResolvedValueOnce("not-json");
    const steps = [
      {
        tap: {
          store: "s",
          action: "a",
          capture: "/api",
        },
      },
    ];
    const result = await runPipeline(steps, { args: {}, source: "internal" });
    expect(result).toEqual(["not-json"]);
  });
});

describe("existing steps still work", () => {
  it("limit step works unchanged", async () => {
    // Test that adding browser steps does not break existing functionality
    const steps = [{ limit: 2 }];
    // When data is null, limit returns empty array
    const result = await runPipeline(steps, { args: {}, source: "internal" });
    expect(result).toEqual([]);
  });
});
