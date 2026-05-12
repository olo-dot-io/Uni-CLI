/**
 * @owner   src/adapters/twitter/quote.ts
 * @does    Register agent-facing Twitter quote-tweet composer automation implemented with site-specific safety checks.
 * @needs   Logged-in x.com browser session, exact tweet URL scoping, optional image upload bridge.
 * @feeds   surface coverage ledger and Twitter quote workflows with attachment guardrails.
 * @breaks  X composer DOM drift or unverified quote-card rendering can post the wrong content.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { cli, Strategy } from "../../registry.js";
import type { AdapterArg } from "../../types.js";
import {
  buildTwitterArticleScopeSource,
  parseTwitterTweetUrl,
} from "./tweet-url.js";

const COMPOSER_FILE_INPUT_SELECTOR =
  'input[type="file"][data-testid="fileInput"]';
const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
]);
const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;
const CONTENT_TYPE_TO_EXTENSION: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

interface QuoteBrowserPage {
  goto: (url: string, opts?: Record<string, unknown>) => Promise<unknown>;
  wait: (args: unknown) => Promise<unknown>;
  evaluate: (script: string) => Promise<unknown>;
  setFileInput?: (selector: string, files: string[]) => Promise<unknown>;
}

interface DownloadedImage {
  absPath: string;
  cleanupDir: string;
}

export function buildQuoteComposerUrl(value: unknown): string {
  const parsed = parseTwitterTweetUrl(value);
  return `https://x.com/compose/post?url=${encodeURIComponent(parsed.url)}`;
}

function normalizeHomePath(value: string): string {
  return value.replace(/^~(?=$|\/)/, homedir());
}

export function resolveTwitterImagePath(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("twitter quote image path cannot be empty.");
  const absPath = resolve(normalizeHomePath(raw));
  if (!existsSync(absPath))
    throw new Error(`Image file not found: ${absPath}.`);
  const ext = extname(absPath).toLowerCase();
  if (!SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported image format "${ext}". Supported: jpg, jpeg, png, gif, webp.`,
    );
  }
  const size = statSync(absPath).size;
  if (size > MAX_IMAGE_SIZE_BYTES) {
    throw new Error(
      `Image too large: ${(size / 1024 / 1024).toFixed(1)} MB (max 20 MB).`,
    );
  }
  return absPath;
}

export function resolveRemoteImageExtension(
  url: string,
  contentType: string | null,
): string {
  const normalizedContentType = String(contentType ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const fromContentType = CONTENT_TYPE_TO_EXTENSION[normalizedContentType];
  if (fromContentType) return fromContentType;
  const fromPath = extname(new URL(url).pathname).toLowerCase();
  if (SUPPORTED_IMAGE_EXTENSIONS.has(fromPath)) return fromPath;
  throw new Error(
    `Unsupported remote image format "${normalizedContentType || "unknown"}". Supported: jpg, jpeg, png, gif, webp.`,
  );
}

export async function downloadTwitterImage(
  value: unknown,
): Promise<DownloadedImage> {
  const raw = String(value ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid image URL: ${raw}.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported image URL protocol: ${parsed.protocol}.`);
  }
  const response = await fetch(parsed.toString());
  if (!response.ok)
    throw new Error(`Image download failed: HTTP ${response.status}.`);
  const contentLength = Number(response.headers.get("content-length") || "0");
  if (contentLength > MAX_IMAGE_SIZE_BYTES) {
    throw new Error(
      `Image too large: ${(contentLength / 1024 / 1024).toFixed(1)} MB (max 20 MB).`,
    );
  }
  const ext = resolveRemoteImageExtension(
    parsed.toString(),
    response.headers.get("content-type"),
  );
  const cleanupDir = mkdtempSync(join(tmpdir(), "unicli-twitter-quote-"));
  const absPath = join(cleanupDir, `image${ext}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_IMAGE_SIZE_BYTES) {
    rmSync(cleanupDir, { recursive: true, force: true });
    throw new Error(
      `Image too large: ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB (max 20 MB).`,
    );
  }
  writeFileSync(absPath, buffer);
  return { absPath, cleanupDir };
}

function mimeTypeForImage(absPath: string): string {
  const ext = extname(absPath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

async function attachComposerImage(
  page: QuoteBrowserPage,
  absImagePath: string,
): Promise<void> {
  let uploaded = false;
  if (page.setFileInput) {
    try {
      await page.setFileInput(COMPOSER_FILE_INPUT_SELECTOR, [absImagePath]);
      uploaded = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/unknown action|not supported/i.test(message)) {
        throw new Error(`Image upload failed: ${message}`);
      }
    }
  }
  if (!uploaded) {
    const base64 = readFileSync(absImagePath).toString("base64");
    const upload = (await page.evaluate(`
      (() => {
        const input = document.querySelector(${JSON.stringify(COMPOSER_FILE_INPUT_SELECTOR)});
        if (!input) return { ok: false, error: 'No file input found on page' };
        const binary = atob(${JSON.stringify(base64)});
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        const transfer = new DataTransfer();
        const blob = new Blob([bytes], { type: ${JSON.stringify(mimeTypeForImage(absImagePath))} });
        transfer.items.add(new File([blob], ${JSON.stringify(basename(absImagePath))}, { type: ${JSON.stringify(mimeTypeForImage(absImagePath))} }));
        Object.defineProperty(input, 'files', { value: transfer.files, writable: false });
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true };
      })()
    `)) as { ok?: boolean; error?: string };
    if (!upload?.ok) {
      throw new Error(
        `Image upload failed: ${upload?.error ?? "unknown error"}.`,
      );
    }
  }
  await page.wait(2);
  const uploadState = (await page.evaluate(`
    (() => {
      const previewCount = document.querySelectorAll(
        '[data-testid="attachments"] img, [data-testid="attachments"] video, [data-testid="tweetPhoto"]'
      ).length;
      const hasMedia = previewCount > 0
        || !!document.querySelector('[data-testid="attachments"]')
        || !!Array.from(document.querySelectorAll('button,[role="button"]')).find((el) =>
          /remove media|remove image|remove/i.test((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || ''))
        );
      return { ok: hasMedia, previewCount };
    })()
  `)) as { ok?: boolean; previewCount?: number };
  if (!uploadState?.ok)
    throw new Error("Image upload failed: preview did not appear.");
}

export function buildQuoteSubmitScript(text: string, tweetId: string): string {
  return `(async () => {
    try {
      ${buildTwitterArticleScopeSource(tweetId)}
      const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
      const boxes = Array.from(document.querySelectorAll('[data-testid="tweetTextarea_0"]'));
      const box = boxes.find(visible) || boxes[0];
      if (!box) return { ok: false, message: 'Could not find the quote composer text area. Are you logged in?' };
      box.focus();
      const textToInsert = ${JSON.stringify(text)};
      if (!document.execCommand('insertText', false, textToInsert)) {
        const transfer = new DataTransfer();
        transfer.setData('text/plain', textToInsert);
        box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      let hasQuoteCard = false;
      for (let i = 0; i < 20; i += 1) {
        hasQuoteCard = __twHasLinkToTarget(document);
        if (hasQuoteCard) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!hasQuoteCard) return { ok: false, message: 'Quote target did not render in the composer. The source tweet may be deleted or restricted.' };
      const buttons = Array.from(document.querySelectorAll('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]'));
      const button = buttons.find((el) => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
      if (!button) return { ok: false, message: 'Tweet button is disabled or not found.' };
      button.click();
      const normalize = (value) => String(value || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
      const expectedText = normalize(textToInsert);
      for (let i = 0; i < 30; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const alerts = Array.from(document.querySelectorAll('[role="alert"], [data-testid="toast"]')).filter(visible);
        const success = alerts.find((el) => /sent|posted|your post was sent|your tweet was sent/i.test(el.textContent || ''));
        if (success) return { ok: true, message: 'Quote tweet posted successfully.' };
        const failure = alerts.find((el) => /failed|error|try again|not sent|could not/i.test(el.textContent || ''));
        if (failure) return { ok: false, message: (failure.textContent || 'Quote tweet failed to post.').trim() };
        const visibleBoxes = Array.from(document.querySelectorAll('[data-testid="tweetTextarea_0"]')).filter(visible);
        const composerStillHasText = visibleBoxes.some((node) => normalize(node.innerText || node.textContent || '').includes(expectedText));
        if (!composerStillHasText) return { ok: true, message: 'Quote tweet posted successfully.' };
      }
      return { ok: false, message: 'Quote tweet submission did not complete before timeout.' };
    } catch (error) {
      return { ok: false, message: String(error?.message || error) };
    }
  })()`;
}

const quoteArgs: AdapterArg[] = [
  {
    name: "url",
    type: "str",
    required: true,
    positional: true,
    description: "Tweet URL to quote",
    format: "uri",
  },
  {
    name: "text",
    type: "str",
    required: true,
    positional: true,
    description: "Quote text",
  },
  { name: "image", type: "str", description: "Optional local image path" },
  { name: "image-url", type: "str", description: "Optional remote image URL" },
];

cli({
  site: "twitter",
  name: "quote",
  description: "Quote-tweet a specific tweet with text and optional image",
  domain: "x.com",
  strategy: Strategy.UI,
  browser: true,
  args: quoteArgs,
  columns: ["status", "message", "text"],
  func: async (page, kwargs) => {
    if (!page || typeof page !== "object") {
      throw new Error("Browser session required for twitter quote.");
    }
    if (kwargs.image && kwargs["image-url"]) {
      throw new Error("Use either --image or --image-url, not both.");
    }
    const browserPage = page as QuoteBrowserPage;
    const target = parseTwitterTweetUrl(kwargs.url);
    const text = String(kwargs.text ?? "").trim();
    if (!text) throw new Error("twitter quote text cannot be empty.");
    let localImagePath: string | undefined;
    let cleanupDir: string | undefined;
    try {
      if (kwargs.image) {
        localImagePath = resolveTwitterImagePath(kwargs.image);
      } else if (kwargs["image-url"]) {
        const downloaded = await downloadTwitterImage(kwargs["image-url"]);
        localImagePath = downloaded.absPath;
        cleanupDir = downloaded.cleanupDir;
      }
      await browserPage.goto(buildQuoteComposerUrl(target.url), {
        waitUntil: "load",
        settleMs: 2500,
      });
      await browserPage.wait({
        selector: '[data-testid="tweetTextarea_0"]',
        timeout: 15,
      });
      if (localImagePath)
        await attachComposerImage(browserPage, localImagePath);
      const result = (await browserPage.evaluate(
        buildQuoteSubmitScript(text, target.id),
      )) as { ok?: boolean; message?: string };
      if (result.ok) await browserPage.wait(3);
      return [
        {
          status: result.ok ? "success" : "failed",
          message: result.message || "",
          text,
          ...(kwargs.image ? { image: kwargs.image } : {}),
          ...(kwargs["image-url"] ? { "image-url": kwargs["image-url"] } : {}),
        },
      ];
    } finally {
      if (cleanupDir) rmSync(cleanupDir, { recursive: true, force: true });
    }
  },
});
