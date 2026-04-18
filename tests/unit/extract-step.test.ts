/**
 * Tests for the extract pipeline step.
 *
 * The extract step uses page.evaluate() to run a JS expression that
 * extracts structured data from DOM elements matching CSS selectors.
 * These tests mock the browser page to verify correct JS generation
 * and result handling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runPipeline } from "../../src/engine/yaml-runner.js";

// Mock the browser modules so tests don't require a running Chrome
vi.mock("../../src/browser/page.js", () => {
  const mockPage = {
    goto: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue("[]"),
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

async function getMockPage() {
  const mod = await import("../../src/browser/page.js");
  return (
    mod as unknown as { __mockPage: Record<string, ReturnType<typeof vi.fn>> }
  ).__mockPage;
}

describe("browser step: extract", () => {
  let mockPage: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    mockPage = await getMockPage();
    mockPage.evaluate.mockReset();
  });

  it("extracts text fields from container elements", async () => {
    const expected = [{ title: "Product A" }, { title: "Product B" }];
    mockPage.evaluate.mockResolvedValueOnce(JSON.stringify(expected));

    const steps = [
      {
        extract: {
          from: ".product-list .item",
          fields: {
            title: { selector: ".title" },
          },
        },
      },
    ];

    const result = await runPipeline(steps, { args: {}, source: "internal" });
    expect(result).toEqual(expected);

    // Verify evaluate was called with JS that queries the right selectors
    const jsArg = mockPage.evaluate.mock.calls[0][0] as string;
    expect(jsArg).toContain(".product-list .item");
    expect(jsArg).toContain(".title");
  });

  it("extracts number fields with pattern", async () => {
    const expected = [{ price: 29.99 }, { price: 49.5 }];
    mockPage.evaluate.mockResolvedValueOnce(JSON.stringify(expected));

    const steps = [
      {
        extract: {
          from: ".product",
          fields: {
            price: {
              selector: ".price",
              type: "number",
              pattern: "\\d+\\.?\\d*",
            },
          },
        },
      },
    ];

    const result = await runPipeline(steps, { args: {}, source: "internal" });
    expect(result).toEqual(expected);

    const jsArg = mockPage.evaluate.mock.calls[0][0] as string;
    expect(jsArg).toContain(".price");
    expect(jsArg).toContain("parseFloat");
    // The pattern is JSON.stringify'd inside the JS, so backslashes are doubled
    expect(jsArg).toContain("\\d+");
    expect(jsArg).toContain("parseFloat(m[0])");
  });

  it("extracts attribute fields", async () => {
    const expected = [
      { url: "https://example.com/a", image: "https://img.com/1.jpg" },
    ];
    mockPage.evaluate.mockResolvedValueOnce(JSON.stringify(expected));

    const steps = [
      {
        extract: {
          from: ".card",
          fields: {
            url: { selector: "a", type: "attribute", attribute: "href" },
            image: { selector: "img", type: "attribute", attribute: "src" },
          },
        },
      },
    ];

    const result = await runPipeline(steps, { args: {}, source: "internal" });
    expect(result).toEqual(expected);

    const jsArg = mockPage.evaluate.mock.calls[0][0] as string;
    expect(jsArg).toContain("getAttribute");
    expect(jsArg).toContain("href");
    expect(jsArg).toContain("src");
  });

  it("handles empty container (no matching elements)", async () => {
    mockPage.evaluate.mockResolvedValueOnce("[]");

    const steps = [
      {
        extract: {
          from: ".nonexistent",
          fields: {
            title: { selector: ".title" },
          },
        },
      },
    ];

    const result = await runPipeline(steps, { args: {}, source: "internal" });
    expect(result).toEqual([]);
  });

  it("works with template expressions in from selector", async () => {
    const expected = [{ name: "Item 1" }];
    mockPage.evaluate.mockResolvedValueOnce(JSON.stringify(expected));

    const steps = [
      {
        extract: {
          from: "#${{ args.section }} .item",
          fields: {
            name: { selector: ".name" },
          },
        },
      },
    ];

    const result = await runPipeline(steps, {
      args: { section: "products" },
      source: "internal",
    });
    expect(result).toEqual(expected);

    const jsArg = mockPage.evaluate.mock.calls[0][0] as string;
    expect(jsArg).toContain("#products .item");
  });

  it("extracts html fields", async () => {
    const expected = [{ content: "<b>Bold</b> text" }];
    mockPage.evaluate.mockResolvedValueOnce(JSON.stringify(expected));

    const steps = [
      {
        extract: {
          from: ".post",
          fields: {
            content: { selector: ".body", type: "html" },
          },
        },
      },
    ];

    const result = await runPipeline(steps, { args: {}, source: "internal" });
    expect(result).toEqual(expected);

    const jsArg = mockPage.evaluate.mock.calls[0][0] as string;
    expect(jsArg).toContain("innerHTML");
  });

  it("extracts text with regex pattern (group 1)", async () => {
    const expected = [{ id: "12345" }];
    mockPage.evaluate.mockResolvedValueOnce(JSON.stringify(expected));

    const steps = [
      {
        extract: {
          from: ".item",
          fields: {
            id: {
              selector: ".meta",
              type: "text",
              pattern: "ID:\\s*(\\d+)",
            },
          },
        },
      },
    ];

    const result = await runPipeline(steps, { args: {}, source: "internal" });
    expect(result).toEqual(expected);

    const jsArg = mockPage.evaluate.mock.calls[0][0] as string;
    expect(jsArg).toContain("ID:\\\\s*(\\\\d+)");
    expect(jsArg).toContain("m[1] || m[0]");
  });

  it("handles malformed JSON from evaluate gracefully", async () => {
    mockPage.evaluate.mockResolvedValueOnce("not valid json");

    const steps = [
      {
        extract: {
          from: ".item",
          fields: {
            title: { selector: ".title" },
          },
        },
      },
    ];

    const result = await runPipeline(steps, { args: {}, source: "internal" });
    expect(result).toEqual([]);
  });

  it("uses default attribute href when type is attribute but no attribute specified", async () => {
    const expected = [{ link: "/page/1" }];
    mockPage.evaluate.mockResolvedValueOnce(JSON.stringify(expected));

    const steps = [
      {
        extract: {
          from: ".nav",
          fields: {
            link: { selector: "a", type: "attribute" },
          },
        },
      },
    ];

    const result = await runPipeline(steps, { args: {}, source: "internal" });
    expect(result).toEqual(expected);

    const jsArg = mockPage.evaluate.mock.calls[0][0] as string;
    expect(jsArg).toContain("getAttribute");
    expect(jsArg).toContain("href");
  });

  it("extracts number fields without pattern (strips non-numeric chars)", async () => {
    const expected = [{ count: 42 }];
    mockPage.evaluate.mockResolvedValueOnce(JSON.stringify(expected));

    const steps = [
      {
        extract: {
          from: ".stats",
          fields: {
            count: { selector: ".count", type: "number" },
          },
        },
      },
    ];

    const result = await runPipeline(steps, { args: {}, source: "internal" });
    expect(result).toEqual(expected);

    const jsArg = mockPage.evaluate.mock.calls[0][0] as string;
    // In the generated JS, the regex is literal: /[^\d.-]/g
    expect(jsArg).toContain("replace(/[^\\d.-]/g");
  });
});
