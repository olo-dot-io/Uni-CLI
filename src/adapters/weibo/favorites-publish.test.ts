import * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveCommand } from "../../registry.js";
import {
  dedupeWeiboFavorites,
  parseWeiboFavoriteCard,
  requireWeiboFavoritesLimit,
  validateWeiboImagePaths,
  validateWeiboPublishText,
} from "./favorites-publish.js";

function pageMock(evaluateResults: unknown[]) {
  const queue = [...evaluateResults];
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async (script: string) => {
      if (String(script).includes("window.scrollBy")) return undefined;
      return queue.shift();
    }),
    setFileInput: vi.fn().mockResolvedValue(undefined),
  };
}

describe("weibo agent-facing favorites and publish commands", () => {
  it("validates favorites limits and parses favorites", () => {
    expect(requireWeiboFavoritesLimit(undefined)).toBe(20);
    expect(() => requireWeiboFavoritesLimit(0)).toThrow("positive integer");
    expect(() => requireWeiboFavoritesLimit(51)).toThrow("<= 50");
    const row = parseWeiboFavoriteCard(
      {
        text: [
          "作者A",
          "昨天 12:00",
          "来自 iPhone",
          "这是一条收藏微博",
          "12",
          "3",
          "2",
        ].join("\n"),
        url: "https://weibo.com/123/AbCd1",
      },
      "https://www.weibo.com/u/page/fav/123456",
    );
    expect(row).toMatchObject({
      author: "作者A",
      text: "这是一条收藏微博",
      time: "昨天 12:00",
      source: "来自 iPhone",
      likes: "12",
      comments: "3",
      reposts: "2",
      url: "https://weibo.com/123/AbCd1",
    });
    expect(
      dedupeWeiboFavorites(
        [row!, row!],
        "https://www.weibo.com/u/page/fav/123456",
      ),
    ).toHaveLength(1);
  });

  it("reads Weibo favorites from the browser page", async () => {
    const command = resolveCommand("weibo", "favorites")?.command;
    const page = pageMock([
      "123456",
      [
        {
          text: ["作者A", "昨天 12:00", "来自 iPhone", "收藏微博内容"].join(
            "\n",
          ),
          url: "https://weibo.com/123/AbCd1",
        },
      ],
    ]);
    await expect(command!.func!(page, { limit: 10 })).resolves.toEqual([
      expect.objectContaining({
        author: "作者A",
        text: "收藏微博内容",
        url: "https://weibo.com/123/AbCd1",
      }),
    ]);
    expect(page.goto).toHaveBeenCalledWith("https://weibo.com");
    expect(page.goto).toHaveBeenCalledWith(
      "https://www.weibo.com/u/page/fav/123456",
    );
  });

  it("validates publish text and image paths before navigation", async () => {
    expect(validateWeiboPublishText(" hello ")).toBe("hello");
    expect(() => validateWeiboPublishText("")).toThrow("cannot be empty");
    const dir = mkdtempSync(join(tmpdir(), "unicli-weibo-"));
    try {
      const png = join(dir, "a.png");
      writeFileSync(png, "png");
      expect(validateWeiboImagePaths(png)).toEqual([png]);
      expect(() => validateWeiboImagePaths(join(dir, "a.bmp"))).toThrow(
        "Unsupported image format",
      );
      expect(() => validateWeiboImagePaths(join(dir, "missing.png"))).toThrow(
        "Not a valid file",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const command = resolveCommand("weibo", "publish")?.command;
    const page = pageMock([]);
    await expect(command!.func!(page, { text: "" })).rejects.toThrow(
      "cannot be empty",
    );
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("publishes text-only Weibo posts when UI reports success", async () => {
    const command = resolveCommand("weibo", "publish")?.command;
    const page = pageMock([
      "123456",
      { ok: true },
      { found: true, visible: true, rectTop: 100 },
      { ok: true, valueLength: 5 },
      { ok: true, label: "发送" },
      { ok: true, message: "发送成功" },
    ]);
    await expect(command!.func!(page, { text: "hello" })).resolves.toEqual([
      { status: "success", message: "发送成功", text: "hello" },
    ]);
    expect(page.goto).toHaveBeenCalledWith("https://weibo.com", {
      waitUntil: "load",
      settleMs: 2000,
    });
  });

  it("uploads images before publishing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-weibo-"));
    const image = join(dir, "a.png");
    writeFileSync(image, "png");
    try {
      const command = resolveCommand("weibo", "publish")?.command;
      const page = pageMock([
        "123456",
        { ok: true },
        { found: true, visible: true, rectTop: 100 },
        true,
        { ok: true, count: 1 },
        { ok: true, valueLength: 5 },
        { ok: true, label: "发送" },
        { ok: true, message: "发送成功" },
      ]);
      await command!.func!(page, { text: "hello", images: image });
      expect(page.setFileInput).toHaveBeenCalledWith(
        'input[type="file"][class*="_file_"]',
        [image],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps publish failures explicit", async () => {
    const command = resolveCommand("weibo", "publish")?.command;
    const page = pageMock([
      "123456",
      { ok: true },
      { found: true, visible: true, rectTop: 100 },
      { ok: true, valueLength: 5 },
      { ok: true, label: "发送" },
      { ok: false, message: "内容违规" },
    ]);
    await expect(command!.func!(page, { text: "hello" })).rejects.toThrow(
      "内容违规",
    );
    expect(fs.existsSync("/path/that/should/not/exist")).toBe(false);
  });
});
