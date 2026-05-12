import { describe, expect, it, vi } from "vitest";
import { resolveCommand } from "../../registry.js";
import {
  buildZlibrarySearchUrl,
  mapZlibrarySearchRows,
  normalizeZlibraryBookUrl,
  requireZlibraryLimit,
} from "./web.js";

function pageMock(evaluateResults: unknown[]) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async () => evaluateResults.shift()),
  };
}

describe("zlibrary agent-facing commands", () => {
  it("validates URLs, queries, limits, and maps rows", () => {
    expect(buildZlibrarySearchUrl(" test book ")).toBe(
      "https://z-library.im/s/test%20book",
    );
    expect(() => buildZlibrarySearchUrl(" ")).toThrow(
      "Z-Library search query cannot be empty.",
    );
    expect(normalizeZlibraryBookUrl("https://z-library.im/book/demo")).toBe(
      "https://z-library.im/book/demo",
    );
    expect(() =>
      normalizeZlibraryBookUrl("https://example.com/book/demo"),
    ).toThrow("Unsupported Z-Library URL host");
    expect(requireZlibraryLimit("25")).toBe(25);
    expect(() => requireZlibraryLimit(26)).toThrow(
      "Z-Library search limit must be <= 25.",
    );
    expect(
      mapZlibrarySearchRows([
        {
          rank: 1,
          title: " Book ",
          author: " Author ",
          url: " https://z-library.im/book/demo ",
        },
      ]),
    ).toEqual([
      {
        rank: 1,
        title: "Book",
        author: "Author",
        url: "https://z-library.im/book/demo",
      },
    ]);
  });

  it("searches Z-Library results", async () => {
    const command = resolveCommand("zlibrary", "search")?.command;
    const page = pageMock([
      [
        {
          rank: 1,
          title: "Book",
          author: "Author",
          url: "https://z-library.im/book/demo",
        },
      ],
    ]);
    await expect(
      command!.func!(page, { query: "book", limit: 10 }),
    ).resolves.toEqual([
      {
        rank: 1,
        title: "Book",
        author: "Author",
        url: "https://z-library.im/book/demo",
      },
    ]);
    expect(page.goto).toHaveBeenCalledWith("https://z-library.im/s/book", {
      waitUntil: "load",
      settleMs: 3000,
    });
    expect(page.wait).toHaveBeenCalledWith(5);
  });

  it("extracts Z-Library book info and formats", async () => {
    const command = resolveCommand("zlibrary", "info")?.command;
    const page = pageMock([
      "Demo Book",
      undefined,
      { pdf: "https://z-library.im/dl/pdf", epub: "" },
    ]);
    await expect(
      command!.func!(page, { url: "https://z-library.im/book/demo" }),
    ).resolves.toEqual([
      {
        title: "Demo Book",
        pdf: "https://z-library.im/dl/pdf",
        epub: "",
        url: "https://z-library.im/book/demo",
      },
    ]);
    expect(page.wait).toHaveBeenCalledWith(5);
    expect(page.wait).toHaveBeenCalledWith(3);
  });
});
