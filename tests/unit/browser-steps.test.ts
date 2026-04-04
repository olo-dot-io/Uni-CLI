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
    waitFor: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    scroll: vi.fn().mockResolvedValue(undefined),
    cookies: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
    sendCDP: vi.fn().mockResolvedValue(undefined),
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
    await runPipeline(steps, { path: "search" });
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
    await runPipeline(steps, {});
    expect(mockPage.goto).toHaveBeenCalledWith("https://example.com", {
      settleMs: 2000,
    });
  });
});

describe("browser step: evaluate", () => {
  it("runs expression and stores result as data", async () => {
    const mockPage = await getMockPage();
    mockPage.evaluate.mockResolvedValueOnce(42);
    const steps = [{ evaluate: { expression: "1 + 1" } }];
    const result = await runPipeline(steps, {});
    expect(mockPage.evaluate).toHaveBeenCalledWith("1 + 1");
    expect(result).toEqual([42]);
  });

  it("accepts string shorthand", async () => {
    const mockPage = await getMockPage();
    mockPage.evaluate.mockResolvedValueOnce("hello");
    const steps = [{ evaluate: "document.title" }];
    const result = await runPipeline(steps, {});
    expect(mockPage.evaluate).toHaveBeenCalledWith("document.title");
    expect(result).toEqual(["hello"]);
  });
});

describe("browser step: click", () => {
  it("clicks resolved selector", async () => {
    const mockPage = await getMockPage();
    const steps = [{ click: { selector: ".btn-${{ args.type }}" } }];
    await runPipeline(steps, { type: "submit" });
    expect(mockPage.click).toHaveBeenCalledWith(".btn-submit");
  });

  it("accepts string shorthand", async () => {
    const mockPage = await getMockPage();
    mockPage.click.mockClear();
    const steps = [{ click: "#main-button" }];
    await runPipeline(steps, {});
    expect(mockPage.click).toHaveBeenCalledWith("#main-button");
  });
});

describe("browser step: type", () => {
  it("types text into a selector", async () => {
    const mockPage = await getMockPage();
    const steps = [
      { type: { selector: "#search", text: "${{ args.query }}" } },
    ];
    await runPipeline(steps, { query: "hello world" });
    expect(mockPage.type).toHaveBeenCalledWith("#search", "hello world");
  });

  it("types text without selector via sendCDP", async () => {
    const mockPage = await getMockPage();
    mockPage.sendCDP.mockClear();
    const steps = [{ type: { text: "raw input" } }];
    await runPipeline(steps, {});
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
    await runPipeline(steps, {});
    expect(mockPage.press).toHaveBeenCalledWith("Enter");
  });
});

describe("browser step: wait", () => {
  it("waits for a fixed number of milliseconds", async () => {
    const mockPage = await getMockPage();
    mockPage.waitFor.mockClear();
    const steps = [{ wait: 100 }];
    await runPipeline(steps, {});
    expect(mockPage.waitFor).toHaveBeenCalledWith(100);
  });

  it("waits for a CSS selector", async () => {
    const mockPage = await getMockPage();
    mockPage.waitFor.mockClear();
    const steps = [{ wait: { selector: ".loaded", timeout: 5000 } }];
    await runPipeline(steps, {});
    expect(mockPage.waitFor).toHaveBeenCalledWith(".loaded", 5000);
  });

  it("waits by ms property", async () => {
    const mockPage = await getMockPage();
    mockPage.waitFor.mockClear();
    const steps = [{ wait: { ms: 500 } }];
    await runPipeline(steps, {});
    expect(mockPage.waitFor).toHaveBeenCalledWith(500);
  });
});

describe("browser step: intercept", () => {
  it("throws PipelineError on timeout when no request captured", async () => {
    const mockPage = await getMockPage();
    // Make evaluate return empty array for capture polling, then throw timeout
    mockPage.evaluate.mockImplementation(async (expr: string) => {
      if (typeof expr === "string" && expr.includes("__unicli_captured")) {
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

    await expect(runPipeline(steps, {})).rejects.toThrow(PipelineError);
    await expect(runPipeline(steps, {})).rejects.toThrow(/Intercept timeout/);
  });
});

describe("browser page cleanup", () => {
  it("calls page.close in finally block", async () => {
    const mockPage = await getMockPage();
    mockPage.close.mockClear();
    mockPage.evaluate.mockResolvedValueOnce("done");
    const steps = [{ evaluate: "document.title" }];
    await runPipeline(steps, {});
    expect(mockPage.close).toHaveBeenCalled();
  });
});

describe("existing steps still work", () => {
  it("limit step works unchanged", async () => {
    // Test that adding browser steps does not break existing functionality
    const steps = [{ limit: 2 }];
    // When data is null, limit returns empty array
    const result = await runPipeline(steps, {});
    expect(result).toEqual([]);
  });
});
