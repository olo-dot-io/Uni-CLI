import { describe, it, expect } from "vitest";
import {
  sanitizeFilename,
  generateFilename,
  requiresYtdlp,
  mapConcurrent,
} from "../../src/engine/download.js";

describe("download utilities", () => {
  it("sanitizeFilename removes dangerous chars", () => {
    expect(sanitizeFilename('file<>:"/\\|?*.txt')).toBe("file_________.txt");
    expect(sanitizeFilename("normal.txt")).toBe("normal.txt");
    expect(sanitizeFilename("")).toBe("download");
    expect(sanitizeFilename("...hidden")).toBe("hidden");
  });

  it("generateFilename extracts from URL", () => {
    expect(generateFilename("https://example.com/img/photo.png", 0)).toBe(
      "photo.png",
    );
    expect(generateFilename("https://example.com/", 3)).toBe("download_3");
    expect(generateFilename("not-a-url", 5)).toBe("download_5");
  });

  it("requiresYtdlp detects video platforms", () => {
    expect(requiresYtdlp("https://www.youtube.com/watch?v=abc")).toBe(true);
    expect(requiresYtdlp("https://www.bilibili.com/video/BV1xx")).toBe(true);
    expect(requiresYtdlp("https://vimeo.com/123456")).toBe(true);
    expect(requiresYtdlp("https://example.com/file.mp4")).toBe(false);
  });

  it("mapConcurrent preserves order", async () => {
    const results = await mapConcurrent(
      [10, 20, 30],
      2,
      async (item, index) => `${index}:${item}`,
    );
    expect(results).toEqual(["0:10", "1:20", "2:30"]);
  });

  it("mapConcurrent respects concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await mapConcurrent(
      [1, 2, 3, 4, 5],
      2,
      async (item) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return item * 2;
      },
    );
    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("mapConcurrent handles empty array", async () => {
    const results = await mapConcurrent([], 3, async (x) => x);
    expect(results).toEqual([]);
  });
});
