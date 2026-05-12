import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveCommand } from "../../registry.js";
import {
  buildXianyuDetectSuccessScript,
  buildXianyuFillFormScript,
  buildXianyuPublishUrl,
  buildXianyuSelectCategoryScript,
  normalizeXianyuPublishArgs,
  validateXianyuCondition,
  validateXianyuImagePaths,
} from "./publish.js";

function pageMock(evaluateResults: unknown[]) {
  const queue = [...evaluateResults];
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async () => queue.shift()),
    setFileInput: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockResolvedValue("https://www.goofish.com/publish"),
  };
}

const validArgs = {
  title: "MacBook Pro",
  description: "成色很好，功能正常",
  price: "5999.99",
  condition: "轻微使用",
  category: "笔记本",
};

describe("xianyu agent-facing publish command", () => {
  it("normalizes and rejects publish arguments before navigation", async () => {
    expect(buildXianyuPublishUrl()).toBe("https://www.goofish.com/publish");
    expect(validateXianyuCondition("轻微使用")).toBe("轻微使用");
    expect(() => validateXianyuCondition("八成新")).toThrow("must be one of");
    expect(normalizeXianyuPublishArgs(validArgs)).toMatchObject({
      title: "MacBook Pro",
      price: "5999.99",
      condition: "轻微使用",
    });
    expect(() =>
      normalizeXianyuPublishArgs({ ...validArgs, title: "   " }),
    ).toThrow("title cannot be empty");
    expect(() =>
      normalizeXianyuPublishArgs({ ...validArgs, price: "0" }),
    ).toThrow("positive price");
    expect(() =>
      normalizeXianyuPublishArgs({ ...validArgs, price: "12.345" }),
    ).toThrow("at most 2 decimals");
    const command = resolveCommand("xianyu", "publish")?.command;
    const page = pageMock([]);
    await expect(
      command!.func!(page, { ...validArgs, title: "" }),
    ).rejects.toThrow("title cannot be empty");
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("validates local images strictly", () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-xianyu-"));
    try {
      const png = join(dir, "a.png");
      writeFileSync(png, "png");
      expect(validateXianyuImagePaths(png)).toEqual([png]);
      expect(() => validateXianyuImagePaths(join(dir, "a.bmp"))).toThrow(
        "Unsupported image format",
      );
      expect(() => validateXianyuImagePaths(join(dir, "missing.png"))).toThrow(
        "Not a valid image file",
      );
      expect(() =>
        validateXianyuImagePaths(
          "1.png,2.png,3.png,4.png,5.png,6.png,7.png,8.png,9.png,10.png",
        ),
      ).toThrow("at most 9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publishes only after each UI step reports positive proof", async () => {
    const command = resolveCommand("xianyu", "publish")?.command;
    const page = pageMock([
      { hasPublishForm: true },
      { ok: true },
      { ok: true, filled: ["title", "description", "price", "condition"] },
      { ok: true },
      {
        status: "published",
        item_id: "123456789012",
        url: "https://www.goofish.com/item?id=123456789012",
      },
    ]);
    await expect(command!.func!(page, validArgs)).resolves.toEqual([
      {
        status: "published",
        item_id: "123456789012",
        title: "MacBook Pro",
        price: "¥5999.99",
        condition: "轻微使用",
        url: "https://www.goofish.com/item?id=123456789012",
        message: "发布成功",
      },
    ]);
    expect(page.goto).toHaveBeenCalledWith("https://www.goofish.com/publish", {
      waitUntil: "load",
      settleMs: 3000,
    });
    expect(page.url).toHaveBeenCalled();
  });

  it("uploads images through Uni-CLI setFileInput(selector, files)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-xianyu-"));
    const image = join(dir, "a.webp");
    writeFileSync(image, "webp");
    try {
      const command = resolveCommand("xianyu", "publish")?.command;
      const page = pageMock([
        { hasPublishForm: true },
        { ok: true },
        { ok: true, filled: ["title", "description", "price", "condition"] },
        { ok: true, selector: "#upload" },
        { ok: true },
        {
          status: "published",
          item_id: "123456789012",
          url: "https://www.goofish.com/item?id=123456789012",
        },
      ]);
      await command!.func!(page, { ...validArgs, images: image });
      expect(page.setFileInput).toHaveBeenCalledWith("#upload", [image]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps auth, form, category, fill, submit, and result failures explicit", async () => {
    const command = resolveCommand("xianyu", "publish")?.command;
    await expect(
      command!.func!(pageMock([{ requiresAuth: true }]), validArgs),
    ).rejects.toThrow("login is required");
    await expect(
      command!.func!(pageMock([{ hasPublishForm: false }]), validArgs),
    ).rejects.toThrow("publish form was not detected");
    await expect(
      command!.func!(
        pageMock([
          { hasPublishForm: true },
          { ok: false, reason: "category-not-found" },
        ]),
        validArgs,
      ),
    ).rejects.toThrow("category-not-found");
    await expect(
      command!.func!(
        pageMock([
          { hasPublishForm: true },
          { ok: true },
          { ok: false, missing: ["price"] },
        ]),
        validArgs,
      ),
    ).rejects.toThrow("missing fields: price");
    await expect(
      command!.func!(
        pageMock([
          { hasPublishForm: true },
          { ok: true },
          { ok: true, filled: ["title", "description", "price", "condition"] },
          { ok: false, reason: "disabled" },
        ]),
        validArgs,
      ),
    ).rejects.toThrow("disabled");
    await expect(
      command!.func!(
        pageMock([
          { hasPublishForm: true },
          { ok: true },
          { ok: true, filled: ["title", "description", "price", "condition"] },
          { ok: true },
          { status: "failed", message: "内容违规" },
        ]),
        validArgs,
      ),
    ).rejects.toThrow("内容违规");
  });

  it("browser scripts carry explicit proof and failure markers", () => {
    const categoryScript = buildXianyuSelectCategoryScript("笔记本");
    expect(categoryScript).toContain("category-trigger-not-found");
    expect(categoryScript).toContain("category-not-found");
    expect(categoryScript).toContain("笔记本");

    const fillScript = buildXianyuFillFormScript(
      normalizeXianyuPublishArgs(validArgs),
    );
    expect(fillScript).toContain("fillFirst('price'");
    expect(fillScript).toContain("missing.push(name)");
    expect(fillScript).toContain("filled.push('condition')");

    const successScript = buildXianyuDetectSuccessScript();
    expect(successScript).toContain("url.match(/item\\?id=(\\d+)/)");
    expect(successScript).toContain("发布成功");
    expect(successScript).toContain("违规");
  });
});
