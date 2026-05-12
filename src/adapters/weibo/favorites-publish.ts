/**
 * @owner   src/adapters/weibo/favorites-publish.ts
 * @does    Register agent-facing Weibo favorites reader and publish command.
 * @needs   Logged-in weibo.com browser session and stable Weibo compose/favorites DOM.
 * @feeds   surface coverage ledger, Weibo collection reading, and Weibo publishing workflows.
 * @breaks  Weibo Vue config changes, favorites virtual-scroller DOM drift, compose selector drift, or upload UI changes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";

const FAVORITES_DEFAULT_LIMIT = 20;
const FAVORITES_MAX_LIMIT = 50;
const MAX_IMAGES = 9;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const TEXTAREA_SELECTOR = "textarea._input_13iqr_8";
const FILE_INPUT_SELECTOR = 'input[type="file"][class*="_file_"]';

interface FavoriteCard {
  text?: unknown;
  url?: unknown;
}

interface FavoriteRow {
  author: string;
  text: string;
  time: string;
  source: string;
  likes: string;
  comments: string;
  reposts: string;
  url: string;
}

interface UiResult {
  ok?: unknown;
  found?: unknown;
  visible?: unknown;
  rectTop?: unknown;
  message?: unknown;
  label?: unknown;
  valueLength?: unknown;
  count?: unknown;
}

export function requireWeiboFavoritesLimit(value: unknown): number {
  const limit = Number(value ?? FAVORITES_DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("weibo favorites limit must be a positive integer.");
  }
  if (limit > FAVORITES_MAX_LIMIT) {
    throw new Error(`weibo favorites limit must be <= ${FAVORITES_MAX_LIMIT}.`);
  }
  return limit;
}

export function validateWeiboPublishText(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("weibo publish text cannot be empty.");
  if (text.length > 2000) {
    throw new Error("weibo publish text exceeds 2000 characters.");
  }
  return text;
}

export function validateWeiboImagePaths(value: unknown): string[] {
  if (!value) return [];
  const parts = String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (parts.length > MAX_IMAGES) {
    throw new Error(`Too many images: ${parts.length} (max ${MAX_IMAGES}).`);
  }
  return parts.map((item) => {
    const absolutePath = path.resolve(item);
    const extension = path.extname(absolutePath).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension)) {
      throw new Error(
        `Unsupported image format "${extension}". Supported: jpg, png, gif, webp.`,
      );
    }
    const stat = fs.statSync(absolutePath, { throwIfNoEntry: false });
    if (!stat?.isFile()) {
      throw new Error(`Not a valid file: ${absolutePath}.`);
    }
    return absolutePath;
  });
}

async function getWeiboSelfUid(page: IPage): Promise<string> {
  const uid = await page.evaluate(`(() => {
    const app = document.querySelector('#app')?.__vue_app__;
    const store = app?.config?.globalProperties?.$store;
    const uid = store?.state?.config?.config?.uid;
    return uid ? String(uid) : null;
  })()`);
  if (uid) return String(uid);
  const configUid = await page.evaluate(`(async () => {
    const response = await fetch('/ajax/config/get_config', { credentials: 'include' });
    if (!response.ok) return null;
    const data = await response.json();
    return data.ok && data.data?.uid ? String(data.data.uid) : null;
  })()`);
  if (configUid) return String(configUid);
  throw new Error("Weibo login is required.");
}

export function parseWeiboFavoriteCard(
  card: FavoriteCard,
  fallbackUrl: string,
): FavoriteRow | null {
  const raw = String(card?.text ?? "");
  const lines = raw.split("\n");
  let author = "";
  let time = "";
  let source = "";
  let content = "";
  let likes = "0";
  let comments = "0";
  let reposts = "0";
  for (const line of lines) {
    const text = line.trim();
    if (!text || text === "添加") continue;
    if (
      !time &&
      /\d+小时前|\d+分钟前|\d+秒前|昨天|前天|\d{1,2}:\d{2}/.test(text)
    ) {
      time = text;
      continue;
    }
    if (text.startsWith("来自")) {
      source = text;
      continue;
    }
    if (content) {
      const n = Number.parseInt(text, 10);
      if (!Number.isNaN(n) && n > 0 && n < 1_000_000 && text === String(n)) {
        if (likes === "0") likes = text;
        else if (comments === "0") comments = text;
        else if (reposts === "0") reposts = text;
        continue;
      }
    }
    if (!author && text.length < 40) {
      author = text;
      continue;
    }
    if (!content && author) {
      content = text;
      continue;
    }
    if (content) content += ` ${text}`;
  }
  if (!content || !author) return null;
  return {
    author,
    text: content.substring(0, 300),
    time,
    source,
    likes,
    comments,
    reposts,
    url: String(card?.url || fallbackUrl),
  };
}

export function dedupeWeiboFavorites(
  items: FavoriteRow[],
  fallbackUrl: string,
): FavoriteRow[] {
  const seen = new Set<string>();
  const result: FavoriteRow[] = [];
  for (const item of items) {
    const key =
      item.url && item.url !== fallbackUrl
        ? item.url
        : `${item.author}\n${item.text}\n${item.time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function buildFavoritesExtractScript(limit: number): string {
  return `(() => {
    const scrollers = document.querySelectorAll('.wbpro-scroller-item, .vue-recycle-scroller__item-view');
    const rows = [];
    for (const scroller of scrollers) {
      const body = scroller.querySelector('[class*="_body_"]') || scroller.querySelector('.wbpro-item-body') || scroller;
      const rawText = body.innerText || scroller.innerText || '';
      let postUrl = '';
      const anchors = scroller.querySelectorAll('a[href]');
      for (const anchor of anchors) {
        const match = String(anchor.href).match(/weibo\\.com\\/(\\d+)\\/([a-zA-Z0-9]+)/);
        if (match) {
          postUrl = 'https://weibo.com/' + match[1] + '/' + match[2];
          break;
        }
      }
      if (rawText.length > 20) rows.push({ text: rawText, url: postUrl });
      if (rows.length >= ${JSON.stringify(limit)}) break;
    }
    return rows;
  })()`;
}

async function waitForTruthy(
  page: IPage,
  script: string,
  attempts: number,
  intervalSeconds: number,
): Promise<UiResult | null> {
  for (let index = 0; index < attempts; index += 1) {
    const result = (await page.evaluate(script)) as UiResult | null;
    if (result?.ok || result?.found || result?.message) return result;
    await page.wait(intervalSeconds);
  }
  return null;
}

cli({
  site: "weibo",
  name: "favorites",
  description: "Read your Weibo favorites",
  domain: "weibo.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "limit", type: "int", default: FAVORITES_DEFAULT_LIMIT }],
  columns: [
    "author",
    "text",
    "time",
    "source",
    "likes",
    "comments",
    "reposts",
    "url",
  ],
  func: async (page, kwargs) => {
    const limit = requireWeiboFavoritesLimit(kwargs.limit);
    const p = page as IPage;
    await p.goto("https://weibo.com");
    await p.wait(2);
    const uid = await getWeiboSelfUid(p);
    const favoritesUrl = `https://www.weibo.com/u/page/fav/${uid}`;
    await p.goto(favoritesUrl);
    await p.wait(4);
    for (let index = 0; index < 3; index += 1) {
      await p.evaluate("() => window.scrollBy(0, 800)");
      await p.wait(1);
    }
    const rawData = await p.evaluate(buildFavoritesExtractScript(limit));
    if (!Array.isArray(rawData) || rawData.length === 0) {
      throw new Error("No Weibo favorites were visible on the favorites page.");
    }
    const rows = rawData
      .map((card) => parseWeiboFavoriteCard(card as FavoriteCard, favoritesUrl))
      .filter((item): item is FavoriteRow => Boolean(item));
    const uniqueRows = dedupeWeiboFavorites(rows, favoritesUrl);
    if (!uniqueRows.length) {
      throw new Error("Failed to parse visible Weibo favorites.");
    }
    return uniqueRows.slice(0, limit);
  },
});

cli({
  site: "weibo",
  name: "publish",
  description: "Publish a new Weibo post immediately",
  domain: "weibo.com",
  strategy: Strategy.UI,
  browser: true,
  args: [
    { name: "text", type: "str", required: true, positional: true },
    { name: "images", type: "str", required: false },
  ],
  columns: ["status", "message", "text"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const text = validateWeiboPublishText(kwargs.text);
    const imagePaths = validateWeiboImagePaths(kwargs.images);
    await p.goto("https://weibo.com", { waitUntil: "load", settleMs: 2000 });
    await p.wait(2);
    await getWeiboSelfUid(p);
    const openResult = (await p.evaluate(`(() => {
      const visible = (element) => Boolean(element && element.offsetParent !== null && !element.disabled);
      const buttons = document.querySelectorAll('button[title="发微博"], button[title="写微博"]');
      for (const button of buttons) {
        if (visible(button)) {
          button.click();
          return { ok: true };
        }
      }
      return { ok: false, message: 'Could not find 发微博 button' };
    })()`)) as UiResult;
    if (!openResult?.ok) {
      throw new Error(
        String(openResult?.message || "Could not open compose editor."),
      );
    }
    const editorResult = await waitForTruthy(
      p,
      `(() => {
        const textarea = document.querySelector(${JSON.stringify(TEXTAREA_SELECTOR)});
        if (!textarea) return { found: false };
        const visible = textarea.offsetParent !== null;
        return { found: true, visible, rectTop: visible ? textarea.getBoundingClientRect().top : -1 };
      })()`,
      34,
      0.3,
    );
    if (
      !editorResult?.found ||
      !editorResult.visible ||
      Number(editorResult.rectTop) < 0
    ) {
      throw new Error("Weibo compose editor did not appear.");
    }
    if (imagePaths.length > 0) {
      const fileInputFound = await p.evaluate(`(() => {
        return Boolean(document.querySelector(${JSON.stringify(FILE_INPUT_SELECTOR)}));
      })()`);
      if (!fileInputFound) {
        throw new Error(
          "Could not find image file input on Weibo compose page.",
        );
      }
      await p.setFileInput(FILE_INPUT_SELECTOR, imagePaths);
      const uploadResult = await waitForTruthy(
        p,
        `(() => {
          const expectedCount = ${JSON.stringify(imagePaths.length)};
          const uploading = document.querySelector('[class*="upload"], [class*="progress"]');
          if (uploading && uploading.offsetParent !== null) return null;
          const images = document.querySelectorAll('img[class*="pic"], [class*="imgItem"], [class*="picture"] img');
          if (images.length >= expectedCount) return { ok: true, count: images.length };
          return null;
        })()`,
        20,
        1.5,
      );
      if (!uploadResult?.ok) {
        throw new Error("Image upload did not complete before timeout.");
      }
    }
    const insertResult = (await p.evaluate(`(() => {
      const textarea = document.querySelector(${JSON.stringify(TEXTAREA_SELECTOR)});
      if (!textarea || textarea.offsetParent === null) return { ok: false, message: 'textarea not visible' };
      textarea.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (nativeSetter) nativeSetter.call(textarea, ${JSON.stringify(text)});
      else textarea.value = ${JSON.stringify(text)};
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, valueLength: textarea.value.length };
    })()`)) as UiResult;
    if (!insertResult?.ok) {
      throw new Error(
        String(insertResult?.message || "Could not insert text."),
      );
    }
    await p.wait(0.5);
    const publishClick = (await p.evaluate(`(() => {
      const visible = (element) => Boolean(element && element.offsetParent !== null && !element.disabled);
      for (const label of ['发送', '发布']) {
        const buttons = document.querySelectorAll('button, [role="button"]');
        for (const button of buttons) {
          const value = (button.innerText || button.textContent || '').trim();
          if (value === label && visible(button)) {
            button.click();
            return { ok: true, label };
          }
        }
      }
      return { ok: false, message: 'Could not find send button' };
    })()`)) as UiResult;
    if (!publishClick?.ok) {
      throw new Error(
        String(publishClick?.message || "Could not click publish."),
      );
    }
    const finalResult = await waitForTruthy(
      p,
      `(() => {
        const successMarkers = ['发布成功', '已发布', '发送成功'];
        const errorMarkers = ['发布失败', '发送失败', '内容违规', '请稍后再试', '频繁'];
        for (const element of document.querySelectorAll('*')) {
          if (element.children.length > 3) continue;
          const value = (element.innerText || '').trim();
          if (!value || value.length > 100) continue;
          for (const marker of successMarkers) {
            if (value.includes(marker) && (value.includes('成功') || value.includes('微博'))) {
              return { ok: true, message: value };
            }
          }
          for (const marker of errorMarkers) {
            if (value.includes(marker)) return { ok: false, message: value };
          }
        }
        return null;
      })()`,
      40,
      0.5,
    );
    if (!finalResult) {
      throw new Error(
        "Publish button clicked but result was unclear. Check Weibo manually.",
      );
    }
    if (!finalResult.ok) {
      throw new Error(String(finalResult.message || "Weibo publish failed."));
    }
    return [
      {
        status: "success",
        message: String(finalResult.message || "Published successfully"),
        text,
      },
    ];
  },
});
