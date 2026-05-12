/**
 * @owner   src/adapters/xianyu/publish.ts
 * @does    Register agent-facing Xianyu publish automation implemented with site-specific safety checks.
 * @needs   Logged-in goofish.com browser session, stable publish form selectors, and optional local image files.
 * @feeds   surface coverage ledger and Xianyu listing publishing workflows.
 * @breaks  Goofish publish-form DOM drift, category chooser changes, or upload input changes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";

const SUPPORTED_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const MAX_IMAGES = 9;
const CONDITION_CHOICES = ["全新", "几乎全新", "轻微使用", "明显使用", "老旧"];

interface XianyuPublishArgs {
  title: string;
  description: string;
  price: string;
  condition: string;
  category: string;
  originalPrice: string | null;
  location: string;
  images: string[];
}

interface UiResult {
  ok?: unknown;
  requiresAuth?: unknown;
  hasPublishForm?: unknown;
  reason?: unknown;
  missing?: unknown;
  selector?: unknown;
  status?: unknown;
  item_id?: unknown;
  url?: unknown;
  message?: unknown;
}

export function buildXianyuPublishUrl(): string {
  return "https://www.goofish.com/publish";
}

async function getCurrentPageUrl(page: IPage): Promise<string> {
  try {
    const currentUrl = await page.url();
    if (currentUrl) return currentUrl;
  } catch {
    return buildXianyuPublishUrl();
  }
  return buildXianyuPublishUrl();
}

export function requireXianyuText(value: unknown, label: string): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) throw new Error(`xianyu publish ${label} cannot be empty.`);
  return text;
}

export function parseXianyuPositivePrice(
  value: unknown,
  label: string,
): string | null {
  if (value == null || String(value).trim() === "") return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new Error(
      `xianyu publish ${label} must be a positive price with at most 2 decimals.`,
    );
  }
  const price = Number(text);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`xianyu publish ${label} must be a positive price.`);
  }
  return text;
}

export function validateXianyuCondition(value: unknown): string {
  const condition = requireXianyuText(value, "condition");
  if (!CONDITION_CHOICES.includes(condition)) {
    throw new Error(
      `xianyu publish condition must be one of: ${CONDITION_CHOICES.join(", ")}.`,
    );
  }
  return condition;
}

export function validateXianyuImagePaths(value: unknown): string[] {
  if (!value) return [];
  const imagePaths = String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (imagePaths.length > MAX_IMAGES) {
    throw new Error(
      `xianyu publish images supports at most ${MAX_IMAGES} files.`,
    );
  }
  return imagePaths.map((imagePath) => {
    const absolutePath = path.resolve(imagePath);
    const extension = path.extname(absolutePath).toLowerCase();
    if (!SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
      throw new Error(
        `Unsupported image format "${extension}". Supported: jpg, jpeg, png, webp.`,
      );
    }
    const stat = fs.statSync(absolutePath, { throwIfNoEntry: false });
    if (!stat?.isFile()) {
      throw new Error(`Not a valid image file: ${absolutePath}.`);
    }
    return absolutePath;
  });
}

export function normalizeXianyuPublishArgs(
  kwargs: Record<string, unknown>,
): XianyuPublishArgs {
  const price = parseXianyuPositivePrice(kwargs.price, "price");
  if (price == null) throw new Error("xianyu publish price cannot be empty.");
  return {
    title: requireXianyuText(kwargs.title, "title"),
    description: requireXianyuText(kwargs.description, "description"),
    price,
    condition: validateXianyuCondition(kwargs.condition),
    category: requireXianyuText(kwargs.category, "category"),
    originalPrice: parseXianyuPositivePrice(
      kwargs.original_price,
      "original_price",
    ),
    location: kwargs.location
      ? requireXianyuText(kwargs.location, "location")
      : "",
    images: validateXianyuImagePaths(kwargs.images),
  };
}

export function buildXianyuPageStateScript(): string {
  return `(() => {
    const bodyText = document.body?.innerText || '';
    const requiresAuth = /请先登录|登录后|立即登录/.test(bodyText);
    const hasPublishForm = /发布闲置|发布宝贝|闲置描述|标题|价格|成色|分类/.test(bodyText);
    return { requiresAuth, hasPublishForm, pageUrl: window.location.href || '' };
  })()`;
}

export function buildXianyuFillFormScript(data: XianyuPublishArgs): string {
  return `(() => {
    const clean = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
    const filled = [];
    const missing = [];
    const setValue = (element, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (!setter) return false;
      element.focus();
      setter.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const fillFirst = (name, selectors, value) => {
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element && setValue(element, value)) {
          filled.push(name);
          return;
        }
      }
      missing.push(name);
    };
    fillFirst('title', ['input[id*="title"]', 'input[placeholder*="标题"]', 'textarea[id*="title"]', '[class*="titleInput"]'], ${JSON.stringify(data.title)});
    fillFirst('description', ['textarea[id*="desc"]', 'textarea[id*="description"]', 'textarea[placeholder*="描述"]', '[class*="descInput"]', '[class*="description"] textarea'], ${JSON.stringify(data.description)});
    fillFirst('price', ['input[id*="price"]', 'input[placeholder*="价"]', 'input[class*="price"]'], ${JSON.stringify(data.price)});
    if (${JSON.stringify(Boolean(data.originalPrice))}) {
      for (const selector of ['input[id*="original"]', 'input[placeholder*="原价"]', 'input[class*="original"]']) {
        const element = document.querySelector(selector);
        if (element && setValue(element, ${JSON.stringify(data.originalPrice)})) {
          filled.push('original_price');
          break;
        }
      }
    }
    if (${JSON.stringify(Boolean(data.location))}) {
      for (const selector of ['input[id*="location"]', 'input[placeholder*="地"]', 'input[class*="location"]']) {
        const element = document.querySelector(selector);
        if (element && setValue(element, ${JSON.stringify(data.location)})) {
          filled.push('location');
          break;
        }
      }
    }
    const condition = ${JSON.stringify(data.condition)};
    const conditionMap = {
      '全新': ['全新', '全新未使用', 'new'],
      '几乎全新': ['几乎全新', '几乎全新无瑕疵', 'like-new'],
      '轻微使用': ['轻微使用', '轻微使用痕迹'],
      '明显使用': ['明显使用', '有明显使用痕迹'],
      '老旧': ['老旧', '年代久远', '二手'],
    };
    const keywords = conditionMap[condition] || [condition];
    const conditionButton = Array.from(document.querySelectorAll('button, [class*="tag"], [class*="condition"], [class*="level"], [role="button"]'))
      .find((element) => {
        const text = clean(element.textContent || '');
        return keywords.some((keyword) => text === keyword || text.includes(keyword));
      });
    if (conditionButton) {
      conditionButton.click();
      filled.push('condition');
    } else {
      missing.push('condition');
    }
    return { ok: missing.length === 0, filled, missing };
  })()`;
}

export function buildXianyuSelectCategoryScript(categoryName: string): string {
  return `(async () => {
    const clean = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
    const categoryTrigger = Array.from(document.querySelectorAll('button, [class*="trigger"], [class*="selector"], [role="button"]'))
      .find((element) => /分类|category|类目/.test(element.textContent || ''))
      || document.querySelector('[class*="category"], [class*="categorySelector"]');
    if (!categoryTrigger) return { ok: false, reason: 'category-trigger-not-found' };
    categoryTrigger.click();
    const waitFor = async (predicate, timeoutMs = 5000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return false;
    };
    const searchKeyword = ${JSON.stringify(categoryName)};
    const hasMatch = await waitFor(() => {
      const nodes = Array.from(document.querySelectorAll('button, [class*="item"], [class*="node"], [role="option"]'));
      return nodes.some((element) => clean(element.textContent || '').includes(searchKeyword));
    });
    if (!hasMatch) return { ok: false, reason: 'category-not-found' };
    const nodes = Array.from(document.querySelectorAll('button, [class*="item"], [class*="node"], [role="option"]'));
    const match = nodes.find((element) => clean(element.textContent || '').includes(searchKeyword));
    if (!match) return { ok: false, reason: 'category-match-failed' };
    match.click();
    return { ok: true };
  })()`;
}

export function buildXianyuFindFileInputScript(): string {
  return `(() => {
    const fileInput = document.querySelector('input[type="file"]');
    if (!fileInput) return { ok: false, reason: 'no-file-input' };
    if (fileInput.id) return { ok: true, selector: '#' + CSS.escape(fileInput.id), hasMultiple: fileInput.multiple };
    if (fileInput.name) return { ok: true, selector: 'input[type="file"][name="' + CSS.escape(fileInput.name) + '"]', hasMultiple: fileInput.multiple };
    const inputs = Array.from(document.querySelectorAll('input'));
    const index = inputs.indexOf(fileInput) + 1;
    return { ok: true, selector: 'input:nth-of-type(' + index + ')', hasMultiple: fileInput.multiple };
  })()`;
}

export function buildXianyuSubmitScript(): string {
  return `(() => {
    const clean = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
    const button = Array.from(document.querySelectorAll('button, [role="button"]'))
      .find((element) => {
        const text = clean(element.textContent || '');
        return /发布|提交|上架|确认/.test(text) && !/取消/.test(text) && !element.disabled;
      })
      || document.querySelector('[class*="publish"], [class*="submit"], [class*="confirm"]');
    if (!button || button.disabled) return { ok: false, reason: 'submit-button-not-found-or-disabled' };
    button.click();
    return { ok: true };
  })()`;
}

export function buildXianyuDetectSuccessScript(): string {
  return `(() => {
    const clean = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
    const bodyText = document.body?.innerText || '';
    const url = window.location.href || '';
    const urlMatch = url.match(/item\\?id=(\\d+)/);
    if (urlMatch) return { status: 'published', item_id: urlMatch[1], url, message: '发布成功' };
    if (/发布成功|上架成功|发布完成/.test(bodyText)) {
      const bodyMatch = bodyText.match(/id[：:]?\\s*(\\d{10,})/);
      return { status: 'published', item_id: bodyMatch ? bodyMatch[1] : '', url, message: '发布成功' };
    }
    const errors = Array.from(document.querySelectorAll('[class*="error"], [class*="fail"]'))
      .map((element) => clean(element.textContent || ''))
      .filter(Boolean);
    if (errors.length || /发布失败|上架失败|异常|错误|违规/.test(bodyText)) {
      return { status: 'failed', message: errors.join(' | ') || 'publish-failed' };
    }
    return { ok: false, reason: 'unknown-state' };
  })()`;
}

cli({
  site: "xianyu",
  name: "publish",
  description:
    "Publish a Xianyu listing from a logged-in Goofish browser session",
  domain: "www.goofish.com",
  strategy: Strategy.UI,
  browser: true,
  args: [
    { name: "title", type: "str", required: true, positional: true },
    { name: "description", type: "str", required: true, positional: true },
    { name: "price", type: "float", required: true, positional: true },
    {
      name: "condition",
      type: "str",
      required: true,
      positional: true,
      choices: CONDITION_CHOICES,
    },
    { name: "category", type: "str", required: true, positional: true },
    { name: "original_price", type: "float" },
    { name: "location", type: "str" },
    { name: "images", type: "str" },
  ],
  columns: [
    "status",
    "item_id",
    "title",
    "price",
    "condition",
    "url",
    "message",
  ],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const data = normalizeXianyuPublishArgs(kwargs);
    await p.goto(buildXianyuPublishUrl(), {
      waitUntil: "load",
      settleMs: 3000,
    });
    await p.wait(3);
    const state = (await p.evaluate(buildXianyuPageStateScript())) as UiResult;
    if (state?.requiresAuth) {
      throw new Error("Xianyu login is required before publishing.");
    }
    if (!state?.hasPublishForm) {
      throw new Error("Xianyu publish form was not detected.");
    }
    const categoryResult = (await p.evaluate(
      buildXianyuSelectCategoryScript(data.category),
    )) as UiResult;
    if (!categoryResult?.ok) {
      throw new Error(
        `Xianyu category selection failed: ${String(categoryResult?.reason || "unknown-reason")}.`,
      );
    }
    await p.wait(1.5);
    const fillResult = (await p.evaluate(
      buildXianyuFillFormScript(data),
    )) as UiResult;
    if (!fillResult?.ok) {
      const missing = Array.isArray(fillResult?.missing)
        ? fillResult.missing.join(", ")
        : "unknown";
      throw new Error(
        `Xianyu publish form fill failed; missing fields: ${missing}.`,
      );
    }
    await p.wait(1);
    if (data.images.length > 0) {
      const fileInput = (await p.evaluate(
        buildXianyuFindFileInputScript(),
      )) as UiResult;
      if (!fileInput?.ok || typeof fileInput.selector !== "string") {
        throw new Error(
          `Xianyu image upload input was not found: ${String(fileInput?.reason || "unknown-reason")}.`,
        );
      }
      await p.setFileInput(fileInput.selector, data.images);
      await p.wait(3);
    }
    const submitResult = (await p.evaluate(
      buildXianyuSubmitScript(),
    )) as UiResult;
    if (!submitResult?.ok) {
      throw new Error(
        `Xianyu publish submit failed: ${String(submitResult?.reason || "unknown-reason")}.`,
      );
    }
    await p.wait(2);
    let finalUrl = await getCurrentPageUrl(p);
    let failReason = "";
    for (let index = 0; index < 10; index += 1) {
      await p.wait(1.5);
      const result = (await p.evaluate(
        buildXianyuDetectSuccessScript(),
      )) as UiResult;
      finalUrl = await getCurrentPageUrl(p);
      if (result?.status === "published") {
        const itemId = String(result.item_id || "").replace(/\D/g, "");
        return [
          {
            status: "published",
            item_id: itemId,
            title: data.title.slice(0, 50),
            price: `¥${data.price}`,
            condition: data.condition,
            url: result.url || finalUrl,
            message: "发布成功",
          },
        ];
      }
      if (result?.status === "failed") {
        failReason = String(result.message || "发布失败");
        break;
      }
    }
    throw new Error(
      failReason ||
        `Xianyu publish result was not confirmed before timeout. Open ${finalUrl} to verify whether the listing was published.`,
    );
  },
});
