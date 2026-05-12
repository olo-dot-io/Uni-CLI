/**
 * @owner   src/adapters/grok/web.ts
 * @does    Register agent-facing Grok web commands implemented with site-specific safety checks.
 * @needs   Logged-in grok.com browser session, Grok chat DOM, optional local image output directory.
 * @feeds   surface coverage ledger and Grok read/history/detail/send/new/status/image workflows.
 * @breaks  Grok DOM drift or weak UUID validation can miss or target the wrong conversation.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cli, Strategy } from "../../registry.js";
import { boolArg, js, str } from "../_shared/browser-tools.js";

const GROK_HOME = "https://grok.com/";
const GROK_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VISIBLE_JS = `const isVisible = (node) => {
  if (!(node instanceof Element)) return false;
  const style = window.getComputedStyle(node);
  if (style.visibility === 'hidden' || style.display === 'none') return false;
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};`;

interface GrokBrowserPage {
  goto: (url: string, opts?: Record<string, unknown>) => Promise<unknown>;
  wait: (seconds: number) => Promise<unknown>;
  evaluate: (script: string) => Promise<unknown>;
}

interface GrokBubble {
  id?: unknown;
  role?: unknown;
  text?: unknown;
  html?: unknown;
}

interface GrokImage {
  src: string;
  w: number;
  h: number;
}

export function normalizeGrokBoolean(
  value: unknown,
  fallback = false,
): boolean {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null || value === "") return fallback;
  return /^(true|1|yes|on)$/i.test(str(value).trim());
}

export function parseGrokSessionId(value: unknown): string {
  const raw = str(value).trim();
  if (!raw) throw new Error("Grok session ID cannot be empty.");
  let candidate = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`Invalid Grok URL: ${raw}.`);
    }
    const host = parsed.hostname.toLowerCase();
    const match = parsed.pathname.match(
      /^\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i,
    );
    if (
      parsed.protocol !== "https:" ||
      (host !== "grok.com" && !host.endsWith(".grok.com")) ||
      !match
    ) {
      throw new Error(
        `Invalid Grok conversation URL: ${raw}. Expected https://grok.com/c/<uuid>.`,
      );
    }
    candidate = match[1];
  }
  if (!GROK_SESSION_ID_RE.test(candidate)) {
    throw new Error(
      `Invalid Grok session ID: ${raw}. Expected a UUID or https://grok.com/c/<uuid>.`,
    );
  }
  return candidate.toLowerCase();
}

export function grokHtmlToMarkdown(value: unknown): string {
  return str(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function mapGrokBubbles(
  bubbles: GrokBubble[],
  wantMarkdown: boolean,
): Record<string, unknown>[] {
  return bubbles
    .map((bubble) => {
      const role = str(bubble.role) === "Assistant" ? "Assistant" : "User";
      const text =
        wantMarkdown && role === "Assistant" && str(bubble.html).trim()
          ? grokHtmlToMarkdown(bubble.html) || str(bubble.text)
          : str(bubble.text);
      return { Role: role, Text: text.trim() };
    })
    .filter((row) => row.Text);
}

export function mapGrokSessions(
  sessions: { id?: unknown; title?: unknown }[],
): Record<string, unknown>[] {
  return sessions
    .map((session, index) => {
      const id = str(session.id).toLowerCase();
      return {
        Index: index + 1,
        Title: str(session.title, "(untitled)").trim() || "(untitled)",
        Url: `${GROK_HOME}c/${id}`,
      };
    })
    .filter((row) => /\/c\/[0-9a-f-]{36}$/i.test(str(row.Url)));
}

export function pickLatestGrokImages(
  bubbleImageSets: GrokImage[][],
  baselineCount: number,
): GrokImage[] {
  const freshSets = bubbleImageSets.slice(Math.max(0, baselineCount));
  for (let i = freshSets.length - 1; i >= 0; i -= 1) {
    if (freshSets[i]?.length) return freshSets[i];
  }
  return [];
}

function outputDir(value: unknown): string {
  return str(value).replace(/^~(?=$|\/)/, homedir());
}

function grokBoundedInt(
  value: unknown,
  fallback: number,
  max: number,
  label: string,
): number {
  const raw = value ?? fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Grok ${label} must be a positive integer.`);
  }
  if (n > max) {
    throw new Error(`Grok ${label} must be <= ${max}.`);
  }
  return n;
}

function imageExt(mime: unknown): string {
  const value = str(mime).toLowerCase();
  if (value.includes("png")) return "png";
  if (value.includes("webp")) return "webp";
  if (value.includes("gif")) return "gif";
  return "jpg";
}

function imageFileName(url: string, mime: string): string {
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 12);
  return `grok-${Date.now()}-${hash}.${imageExt(mime)}`;
}

function imageSignature(images: GrokImage[]): string {
  return images
    .map((image) => image.src)
    .sort()
    .join("|");
}

async function currentUrl(page: GrokBrowserPage): Promise<string> {
  const value = await page.evaluate("window.location.href").catch(() => "");
  return typeof value === "string" ? value : "";
}

async function ensureOnGrok(page: GrokBrowserPage): Promise<void> {
  const url = await currentUrl(page);
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "grok.com" || host.endsWith(".grok.com")) return;
  } catch {
    await page.goto(GROK_HOME, { waitUntil: "load", settleMs: 2500 });
    await page.wait(2);
    return;
  }
  await page.goto(GROK_HOME, { waitUntil: "load", settleMs: 2500 });
  await page.wait(2);
}

async function isLoggedIn(page: GrokBrowserPage): Promise<boolean> {
  const result = await page.evaluate(`(() => {
    ${VISIBLE_JS}
    const composer = document.querySelector('.ProseMirror[contenteditable="true"]');
    if (composer && isVisible(composer)) {
      const signInCta = Array.from(document.querySelectorAll('button, a'))
        .some((node) => isVisible(node) && /^(sign in|log in)$/i.test((node.textContent || '').trim()));
      return !signInCta;
    }
    return false;
  })()`);
  return Boolean(result);
}

async function getCurrentSessionId(page: GrokBrowserPage): Promise<string> {
  const url = await currentUrl(page);
  const match = url.match(
    /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  return match ? match[1].toLowerCase() : "";
}

async function getModelLabel(page: GrokBrowserPage): Promise<string> {
  const result = await page.evaluate(`(() => {
    ${VISIBLE_JS}
    const trigger = Array.from(document.querySelectorAll('button[aria-label="Model select"]'))
      .find((node) => isVisible(node));
    return trigger ? (trigger.innerText || trigger.textContent || '').trim().split('\\n')[0].trim() : '';
  })()`);
  return typeof result === "string" ? result : "";
}

async function getMessageBubbles(page: GrokBrowserPage): Promise<GrokBubble[]> {
  const result = await page.evaluate(`(() => {
    ${VISIBLE_JS}
    const findResponseId = (node) => {
      let parent = node.parentElement;
      while (parent && parent !== document.body) {
        const id = parent.getAttribute('id') || '';
        if (id.startsWith('response-')) return id.slice('response-'.length);
        parent = parent.parentElement;
      }
      return '';
    };
    const bubbles = Array.from(document.querySelectorAll('[data-testid="user-message"], [data-testid="assistant-message"]'))
      .filter((node) => node instanceof HTMLElement && isVisible(node));
    return bubbles.map((node, index) => {
      const isAssistant = node.getAttribute('data-testid') === 'assistant-message';
      const responseId = findResponseId(node) || ('pos-' + index);
      const html = node.innerHTML || '';
      const text = (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim();
      return {
        id: responseId + (isAssistant ? '-assistant' : '-user'),
        role: isAssistant ? 'Assistant' : 'User',
        text,
        html,
      };
    });
  })()`);
  return Array.isArray(result)
    ? (result as GrokBubble[]).filter(
        (bubble) => str(bubble.id) && (str(bubble.text) || str(bubble.html)),
      )
    : [];
}

async function getHistoryFromSidebar(
  page: GrokBrowserPage,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const result = await page.evaluate(`(() => {
    ${VISIBLE_JS}
    const re = /^\\/c\\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
    const entries = [];
    const seen = new Set();
    const anchors = Array.from(document.querySelectorAll('a[href^="/c/"]'));
    for (const a of anchors) {
      if (!(a instanceof HTMLElement) || !isVisible(a)) continue;
      const href = a.getAttribute('href') || '';
      const match = href.match(re);
      if (!match) continue;
      const id = match[1].toLowerCase();
      const title = (a.innerText || a.textContent || '').trim();
      if (!seen.has(id)) {
        seen.add(id);
        entries.push({ id, title });
      } else if (title) {
        const existing = entries.find((entry) => entry.id === id);
        if (existing && !existing.title) existing.title = title;
      }
    }
    return entries;
  })()`);
  const sessions = Array.isArray(result)
    ? (result as { id?: unknown; title?: unknown }[])
    : [];
  const rows = mapGrokSessions(sessions).slice(0, limit);
  if (!rows.length)
    throw new Error("No Grok conversations found in the sidebar.");
  return rows;
}

async function startNewChat(page: GrokBrowserPage): Promise<void> {
  await page.goto(GROK_HOME, { waitUntil: "load", settleMs: 2500 });
  await page.wait(2);
}

async function sendGrokMessage(
  page: GrokBrowserPage,
  prompt: string,
): Promise<void> {
  const result = (await page.evaluate(`(async () => {
    const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const composerSelector = '.ProseMirror[contenteditable="true"]';
    let composer = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const candidate = document.querySelector(composerSelector);
      if (candidate instanceof HTMLElement) {
        composer = candidate;
        break;
      }
      await waitFor(500);
    }
    if (!(composer instanceof HTMLElement)) {
      return { ok: false, reason: 'Grok composer (.ProseMirror) was not found on grok.com.' };
    }
    const editor = composer.editor;
    if (!editor?.commands?.focus || !editor?.commands?.insertContent) {
      return { ok: false, reason: 'Grok composer editor API was unavailable.' };
    }
    if (typeof editor.commands.clearContent === 'function') editor.commands.clearContent();
    editor.commands.focus();
    editor.commands.insertContent(${js(prompt)});
    const isClickableSubmit = (node) => {
      if (!(node instanceof HTMLButtonElement)) return false;
      if (node.disabled) return false;
      const style = window.getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const submit = Array.from(document.querySelectorAll('button[aria-label="Submit"]')).find(isClickableSubmit);
      if (submit instanceof HTMLButtonElement) {
        submit.click();
        return { ok: true };
      }
      await waitFor(500);
    }
    return { ok: false, reason: 'Grok submit button did not reach a clickable state.' };
  })()`)) as { ok?: boolean; reason?: string };
  if (!result?.ok)
    throw new Error(result?.reason || "Failed to send Grok prompt.");
}

async function getBubbleImageSets(
  page: GrokBrowserPage,
): Promise<GrokImage[][]> {
  const result = await page.evaluate(`(() => {
    const bubbles = document.querySelectorAll('div.message-bubble, [data-testid="message-bubble"], [data-testid="assistant-message"]');
    const dedupe = (images) => {
      const seen = new Set();
      const out = [];
      for (const image of images) {
        if (!image.src || seen.has(image.src)) continue;
        seen.add(image.src);
        out.push(image);
      }
      return out;
    };
    return Array.from(bubbles).map((bubble) => dedupe(Array.from(bubble.querySelectorAll('img'))
      .map((img) => ({
        src: img.currentSrc || img.src || '',
        w: img.naturalWidth || img.width || 0,
        h: img.naturalHeight || img.height || 0,
      }))
      .filter((image) => image.src && /^https?:/.test(image.src))
      .filter((image) => (image.w === 0 || image.w >= 128) && (image.h === 0 || image.h >= 128))));
  })()`);
  if (!Array.isArray(result)) return [];
  return result.map((set) =>
    Array.isArray(set)
      ? set
          .map((image) => ({
            src: str((image as GrokImage).src),
            w: Number((image as GrokImage).w) || 0,
            h: Number((image as GrokImage).h) || 0,
          }))
          .filter((image) => image.src)
      : [],
  );
}

async function fetchImageAsset(
  page: GrokBrowserPage,
  url: string,
): Promise<{ mime: string; base64: string }> {
  const result = (await page.evaluate(`(async () => {
    const response = await fetch(${js(url)}, { credentials: 'include', referrer: 'https://grok.com/' });
    if (!response.ok) return { ok: false, status: response.status };
    const blob = await response.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return { ok: true, mime: blob.type || 'image/jpeg', base64: btoa(binary) };
  })()`)) as { ok?: boolean; status?: number; mime?: string; base64?: string };
  if (!result?.ok || !result.base64) {
    throw new Error(
      `Failed to download Grok image ${url}: status=${result?.status ?? "?"}.`,
    );
  }
  return { mime: str(result.mime), base64: result.base64 };
}

cli({
  site: "grok",
  name: "read",
  description: "Read messages in the current Grok conversation",
  domain: "grok.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "markdown", type: "bool", default: false }],
  columns: ["Role", "Text"],
  func: async (page, kwargs) => {
    const p = page as GrokBrowserPage;
    await ensureOnGrok(p);
    await p.wait(2);
    const rows = mapGrokBubbles(
      await getMessageBubbles(p),
      normalizeGrokBoolean(kwargs.markdown),
    );
    if (!rows.length)
      throw new Error("No visible Grok messages in the current conversation.");
    return rows;
  },
});

cli({
  site: "grok",
  name: "history",
  description: "List recent Grok conversations from the sidebar",
  domain: "grok.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "limit", type: "int", default: 20 }],
  columns: ["Index", "Title", "Url"],
  func: async (page, kwargs) => {
    const p = page as GrokBrowserPage;
    const limit = grokBoundedInt(kwargs.limit, 20, 100, "history limit");
    await ensureOnGrok(p);
    await p.wait(2);
    if (!(await isLoggedIn(p))) throw new Error("Grok login is required.");
    return getHistoryFromSidebar(p, limit);
  },
});

cli({
  site: "grok",
  name: "detail",
  description: "Open a Grok conversation by ID and read its messages",
  domain: "grok.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "id", type: "str", required: true, positional: true },
    { name: "markdown", type: "bool", default: false },
  ],
  columns: ["Role", "Text"],
  func: async (page, kwargs) => {
    const p = page as GrokBrowserPage;
    const sessionId = parseGrokSessionId(kwargs.id);
    await p.goto(`${GROK_HOME}c/${sessionId}`, {
      waitUntil: "load",
      settleMs: 2500,
    });
    const startedAt = Date.now();
    while (Date.now() - startedAt < 20_000) {
      const rows = mapGrokBubbles(
        await getMessageBubbles(p),
        normalizeGrokBoolean(kwargs.markdown),
      );
      if (rows.length) return rows;
      await p.wait(1);
    }
    throw new Error(
      `No visible Grok messages found for conversation ${sessionId}.`,
    );
  },
});

cli({
  site: "grok",
  name: "send",
  description: "Send a prompt to Grok without waiting for the reply",
  domain: "grok.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "prompt", type: "str", required: true, positional: true },
    { name: "new", type: "bool", default: false },
  ],
  columns: ["Status", "Prompt"],
  func: async (page, kwargs) => {
    const prompt = str(kwargs.prompt).trim();
    if (!prompt) throw new Error("Grok prompt cannot be empty.");
    const p = page as GrokBrowserPage;
    await ensureOnGrok(p);
    if (boolArg(kwargs.new)) await startNewChat(p);
    await sendGrokMessage(p, prompt);
    return [{ Status: "sent", Prompt: prompt }];
  },
});

cli({
  site: "grok",
  name: "new",
  description: "Start a new conversation in Grok",
  domain: "grok.com",
  strategy: Strategy.COOKIE,
  browser: true,
  columns: ["Status"],
  func: async (page) => {
    await startNewChat(page as GrokBrowserPage);
    return [{ Status: "New chat started" }];
  },
});

cli({
  site: "grok",
  name: "status",
  description:
    "Check Grok page availability, login state, current session and model",
  domain: "grok.com",
  strategy: Strategy.COOKIE,
  browser: true,
  columns: ["Status", "Login", "Model", "SessionId", "Url"],
  func: async (page) => {
    const p = page as GrokBrowserPage;
    await ensureOnGrok(p);
    await p.wait(2);
    const [loggedIn, sessionId, model, url] = await Promise.all([
      isLoggedIn(p),
      getCurrentSessionId(p),
      getModelLabel(p),
      currentUrl(p),
    ]);
    return [
      {
        Status: "Connected",
        Login: loggedIn ? "Yes" : "No",
        Model: model || null,
        SessionId: sessionId || null,
        Url: url,
      },
    ];
  },
});

cli({
  site: "grok",
  name: "image",
  description: "Generate images with Grok and return or save image assets",
  domain: "grok.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "prompt", type: "str", required: true, positional: true },
    { name: "timeout", type: "int", default: 240 },
    { name: "new", type: "bool", default: false },
    { name: "count", type: "int", default: 1 },
    { name: "out", type: "str", default: "" },
  ],
  columns: ["url", "width", "height", "path"],
  func: async (page, kwargs) => {
    const prompt = str(kwargs.prompt).trim();
    if (!prompt) throw new Error("Grok image prompt cannot be empty.");
    const p = page as GrokBrowserPage;
    const timeout = grokBoundedInt(kwargs.timeout, 240, 600, "image timeout");
    const minCount = grokBoundedInt(kwargs.count, 1, 100, "image count");
    await ensureOnGrok(p);
    if (normalizeGrokBoolean(kwargs.new)) await startNewChat(p);
    const baselineCount = (await getBubbleImageSets(p)).length;
    await sendGrokMessage(p, prompt);
    const startedAt = Date.now();
    let lastSignature = "";
    let stableCount = 0;
    let lastImages: GrokImage[] = [];
    while (Date.now() - startedAt < timeout * 1000) {
      await p.wait(3);
      const images = pickLatestGrokImages(
        await getBubbleImageSets(p),
        baselineCount,
      );
      if (images.length >= minCount) {
        const signature = imageSignature(images);
        if (signature === lastSignature) {
          stableCount += 1;
          if (stableCount >= 2) {
            lastImages = images;
            break;
          }
        } else {
          stableCount = 0;
          lastSignature = signature;
          lastImages = images;
        }
      }
    }
    if (!lastImages.length)
      throw new Error("No generated Grok images observed before timeout.");
    const dir = str(kwargs.out).trim() ? outputDir(kwargs.out) : "";
    if (dir) mkdirSync(dir, { recursive: true });
    const rows: Record<string, unknown>[] = [];
    for (const image of lastImages) {
      let filePath = "";
      if (dir) {
        const asset = await fetchImageAsset(p, image.src);
        filePath = join(dir, imageFileName(image.src, asset.mime));
        writeFileSync(filePath, Buffer.from(asset.base64, "base64"));
      }
      rows.push({
        url: image.src,
        width: image.w,
        height: image.h,
        path: filePath,
      });
    }
    return rows;
  },
});
