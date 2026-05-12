/**
 * @owner   src/adapters/qwen/web.ts
 * @does    Register agent-facing Qwen web chat commands implemented with site-specific safety checks.
 * @needs   Logged-in qianwen.com browser session, Qwen chat DOM/API, optional local image output directory.
 * @feeds   surface coverage ledger and Qwen ask/read/send/history/detail/new/status/image workflows.
 * @breaks  Qwen DOM/API drift or weak session-id validation can miss or target the wrong chat.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cli, Strategy } from "../../registry.js";
import { boolArg, js, str } from "../_shared/browser-tools.js";

const QWEN_HOME = "https://www.qianwen.com/";
const QWEN_API_DOMAIN = "chat2-api.qianwen.com";
const SESSION_ID_RE = /^[a-f0-9]{32}$/i;
const VISIBLE_JS = `const isVisible = (node) => {
  if (!(node instanceof Element)) return false;
  const style = window.getComputedStyle(node);
  if (style.visibility === 'hidden' || style.display === 'none') return false;
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};`;

interface QwenBrowserPage {
  goto: (url: string, opts?: Record<string, unknown>) => Promise<unknown>;
  wait: (args: unknown) => Promise<unknown>;
  evaluate: (script: string) => Promise<unknown>;
}

interface QwenBubble {
  id?: unknown;
  role?: unknown;
  text?: unknown;
  html?: unknown;
}

interface QwenSession {
  id?: unknown;
  title?: unknown;
  updated_at?: unknown;
}

export function parseQwenSessionId(value: unknown): string {
  const raw = str(value).trim();
  if (!raw) throw new Error("Qwen session ID cannot be empty.");
  const urlMatch = raw.match(/qianwen\.com\/chat\/([a-f0-9]{32})(?:[/?#]|$)/i);
  const candidate = urlMatch?.[1] ?? raw;
  if (!SESSION_ID_RE.test(candidate)) {
    throw new Error(
      `Invalid Qwen session ID: ${raw}. Expected a 32-character hex ID or https://www.qianwen.com/chat/<id>.`,
    );
  }
  return candidate.toLowerCase();
}

export function qwenHtmlToMarkdown(value: unknown): string {
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

export function normalizeQwenBoolean(
  value: unknown,
  fallback = false,
): boolean {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null || value === "") return fallback;
  return /^(true|1|yes|on)$/i.test(str(value).trim());
}

export function mapQwenBubbles(
  bubbles: QwenBubble[],
  wantMarkdown: boolean,
): Record<string, unknown>[] {
  return bubbles
    .map((bubble) => {
      const role = str(bubble.role) === "Assistant" ? "Assistant" : "User";
      const text =
        wantMarkdown && role === "Assistant" && str(bubble.html).trim()
          ? qwenHtmlToMarkdown(bubble.html) || str(bubble.text)
          : str(bubble.text);
      return { Role: role, Text: text.trim() };
    })
    .filter((row) => row.Text);
}

export function formatQwenDate(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  const date = new Date(n);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function mapQwenSessions(
  sessions: QwenSession[],
): Record<string, unknown>[] {
  return sessions
    .map((session, index) => {
      const id = str(session.id);
      return {
        Index: index + 1,
        Title: str(session.title, "(untitled)").trim() || "(untitled)",
        Updated: formatQwenDate(session.updated_at),
        Url: `${QWEN_HOME}chat/${id}`,
      };
    })
    .filter((row) => /\/chat\/[a-f0-9]{32}$/i.test(str(row.Url)));
}

function qwenOutputDir(value: unknown): string {
  return str(value, "~/Pictures/qianwen").replace(/^~(?=$|\/)/, homedir());
}

function qwenBoundedInt(
  value: unknown,
  fallback: number,
  max: number,
  label: string,
): number {
  const raw = value ?? fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Qwen ${label} must be a positive integer.`);
  }
  if (n > max) {
    throw new Error(`Qwen ${label} must be <= ${max}.`);
  }
  return n;
}

function qwenImageExt(mime: unknown): string {
  const value = str(mime).toLowerCase();
  if (value.includes("png")) return ".png";
  if (value.includes("webp")) return ".webp";
  if (value.includes("gif")) return ".gif";
  return ".jpg";
}

function displayPath(filePath: string): string {
  return filePath.startsWith(homedir())
    ? `~${filePath.slice(homedir().length)}`
    : filePath;
}

async function currentUrl(page: QwenBrowserPage): Promise<string> {
  const value = await page.evaluate("window.location.href").catch(() => "");
  return typeof value === "string" ? value : "";
}

async function ensureOnQwen(page: QwenBrowserPage): Promise<void> {
  const url = await currentUrl(page);
  if (!url.includes("qianwen.com")) {
    await page.goto(QWEN_HOME, { waitUntil: "load", settleMs: 2500 });
    await page.wait(2);
  }
}

async function dismissLoginModal(page: QwenBrowserPage): Promise<void> {
  await page.evaluate(`(() => {
    ${VISIBLE_JS}
    const modal = document.querySelector('[role=alert-biz-modal]');
    if (!modal || !isVisible(modal)) return false;
    const target = Array.from(modal.querySelectorAll('div, button, span'))
      .filter((node) => node instanceof HTMLElement && isVisible(node))
      .find((node) => /close|dismiss|cancel/i.test(String(node.className || '')) || node.getAttribute('aria-label') === '关闭')
      || modal.querySelector('svg')?.parentElement;
    if (target instanceof HTMLElement) {
      target.click();
      return true;
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    return true;
  })()`);
}

async function hasLoginGate(page: QwenBrowserPage): Promise<boolean> {
  const result = await page.evaluate(`(() => {
    ${VISIBLE_JS}
    const modal = document.querySelector('[role=alert-biz-modal]');
    if (modal && isVisible(modal)) {
      const src = modal.querySelector('iframe')?.getAttribute('src') || '';
      if (src.includes('passport.qianwen.com') || src.includes('login')) return true;
    }
    return false;
  })()`);
  return Boolean(result);
}

async function isLoggedIn(page: QwenBrowserPage): Promise<boolean> {
  const result = await page.evaluate(`(() => {
    ${VISIBLE_JS}
    const loginButton = Array.from(document.querySelectorAll('button'))
      .find((node) => (node.textContent || '').trim() === '登录' && isVisible(node));
    if (loginButton) return false;
    const hint = Array.from(document.querySelectorAll('p'))
      .find((node) => (node.textContent || '').includes('登录可同步历史对话'));
    return !(hint && isVisible(hint));
  })()`);
  return Boolean(result);
}

async function startNewChat(page: QwenBrowserPage): Promise<void> {
  const result = await page.evaluate(`(() => {
    ${VISIBLE_JS}
    const button = Array.from(document.querySelectorAll('button'))
      .find((node) => isVisible(node) && (node.innerText || '').trim() === '新建对话');
    if (button instanceof HTMLElement) {
      button.click();
      return true;
    }
    return false;
  })()`);
  if (result) {
    await page.wait(1.5);
    return;
  }
  await page.goto(QWEN_HOME, { waitUntil: "load", settleMs: 2500 });
  await page.wait(2);
}

async function setFeatureToggle(
  page: QwenBrowserPage,
  feature: "think" | "research" | "image",
  enabled: boolean,
): Promise<void> {
  const labels: Record<typeof feature, string> = {
    think: "深度思考",
    research: "深度研究",
    image: "AI生图",
  };
  await page.evaluate(`(async () => {
    ${VISIBLE_JS}
    const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const button = Array.from(document.querySelectorAll('button[aria-label]'))
      .find((node) => isVisible(node) && node.getAttribute('aria-label') === ${js(labels[feature])});
    if (!(button instanceof HTMLElement)) return false;
    const selected = button.getAttribute('aria-pressed') === 'true'
      || /active|selected|bg-primary/.test(String(button.className || ''));
    if (selected === ${JSON.stringify(enabled)}) return true;
    button.click();
    await waitFor(300);
    return true;
  })()`);
}

async function sendQwenMessage(
  page: QwenBrowserPage,
  prompt: string,
): Promise<void> {
  const result = (await page.evaluate(`(async () => {
    ${VISIBLE_JS}
    const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const editor = Array.from(document.querySelectorAll('[role=textbox][contenteditable=true]'))
      .find((node) => isVisible(node));
    if (!(editor instanceof HTMLElement)) return { ok: false, reason: 'Qwen composer not found.' };
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand('delete', false);
    await waitFor(100);
    editor.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'insertText',
      data: ${js(prompt)},
      bubbles: true,
      cancelable: true,
    }));
    await waitFor(400);
    const sendButton = document.querySelector('button[aria-label="发送消息"]');
    if (sendButton instanceof HTMLButtonElement && !sendButton.disabled) {
      sendButton.click();
      return { ok: true, action: 'click' };
    }
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    return { ok: true, action: 'enter' };
  })()`)) as { ok?: boolean; reason?: string };
  if (!result?.ok)
    throw new Error(result?.reason || "Failed to send Qwen prompt.");
}

async function getMessageBubbles(page: QwenBrowserPage): Promise<QwenBubble[]> {
  const result = await page.evaluate(`(() => {
    ${VISIBLE_JS}
    const wraps = Array.from(document.querySelectorAll('[data-chat-question-wrap], [data-chat-answers-wrap]'))
      .filter((node) => node instanceof HTMLElement && isVisible(node));
    const findTurnId = (node) => {
      let parent = node.parentElement;
      while (parent && parent !== document.body) {
        const reqEl = parent.querySelector('[data-req-id]');
        if (reqEl?.getAttribute('data-req-id')) return reqEl.getAttribute('data-req-id');
        parent = parent.parentElement;
      }
      return '';
    };
    return wraps.map((node, index) => {
      const isAnswer = node.hasAttribute('data-chat-answers-wrap');
      const contentNode = isAnswer
        ? (node.querySelector('#qk-markdown-react') || node.querySelector('[class*="markdown"]') || node)
        : node;
      const html = contentNode instanceof HTMLElement ? (contentNode.innerHTML || '') : '';
      const text = contentNode instanceof HTMLElement ? (contentNode.innerText || contentNode.textContent || '') : '';
      const baseId = findTurnId(node) || ('pos-' + index);
      return {
        id: baseId + (isAnswer ? '-answer' : '-question'),
        role: isAnswer ? 'Assistant' : 'User',
        text: String(text || '').replace(/\\s+/g, ' ').trim(),
        html,
      };
    });
  })()`);
  return Array.isArray(result)
    ? (result as QwenBubble[]).filter(
        (bubble) => str(bubble.id) && str(bubble.text),
      )
    : [];
}

async function waitForQwenAnswer(
  page: QwenBrowserPage,
  prompt: string,
  timeout: number,
): Promise<QwenBubble> {
  const startedAt = Date.now();
  let previous = "";
  let stable = 0;
  let candidate: QwenBubble | null = null;
  while (Date.now() - startedAt < timeout * 1000) {
    await page.wait(2);
    if (await hasLoginGate(page)) throw new Error("Qwen login is required.");
    const bubbles = await getMessageBubbles(page);
    const assistant = [...bubbles]
      .reverse()
      .find((bubble) => bubble.role === "Assistant");
    const text = str(assistant?.text).trim();
    if (!text || text === prompt.trim()) continue;
    candidate = assistant ?? null;
    if (text === previous) {
      stable += 1;
      if (Date.now() - startedAt >= 6000 && stable >= 2 && candidate) {
        return candidate;
      }
    } else {
      previous = text;
      stable = 0;
    }
  }
  if (candidate) return candidate;
  throw new Error("No Qwen reply observed before timeout.");
}

async function getSessionList(
  page: QwenBrowserPage,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const raw = (await page.evaluate(`(async () => {
    try {
      const utdid = (document.cookie.match(/(?:^|;\\s*)b-user-id=([^;]+)/)?.[1])
        || (document.cookie.match(/(?:^|;\\s*)utdid=([^;]+)/)?.[1])
        || '';
      const query = new URLSearchParams({
        biz_id: 'ai_qwen',
        chat_client: 'h5',
        device: 'pc',
        fr: 'pc',
        pr: 'qwen',
        ut: utdid,
        la: 'zh-CN',
        tz: 'Asia/Shanghai',
        ve: '2.4.9',
      }).toString();
      const response = await fetch('https://${QWEN_API_DOMAIN}/api/v2/session/page/list?' + query, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page_num: 1, page_size: ${limit}, page_no: 1 }),
      });
      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      return { ok: response.ok, status: response.status, body };
    } catch (error) {
      return { ok: false, status: 0, error: String(error?.message || error) };
    }
  })()`)) as { ok?: boolean; status?: number; body?: Record<string, unknown> };
  if (!raw?.ok)
    throw new Error(`Qwen history API failed (status=${raw?.status ?? 0}).`);
  const data = (raw.body?.data || raw.body?.result || {}) as Record<
    string,
    unknown
  >;
  const list = Array.isArray(data.list)
    ? data.list
    : Array.isArray(data.items)
      ? data.items
      : Array.isArray(data.page_list)
        ? data.page_list
        : Array.isArray(raw.body?.list)
          ? raw.body.list
          : [];
  const sessions = list
    .map((item) => {
      const row = item as Record<string, unknown>;
      return {
        id: str(row.session_id || row.sessionId || row.id),
        title: str(row.title || row.name || row.summary).trim(),
        updated_at: Number(
          row.updated_at ||
            row.last_req_timestamp ||
            row.updatedAt ||
            row.gmt_modified ||
            row.update_time ||
            0,
        ),
      };
    })
    .filter((item) => item.id);
  const rows = mapQwenSessions(sessions).slice(0, limit);
  if (!rows.length) throw new Error("No Qwen conversations found.");
  return rows;
}

async function collectImageUrls(
  page: QwenBrowserPage,
  assistantId: string,
): Promise<string[]> {
  const urls = await page.evaluate(`(() => {
    const scope = ${js(assistantId)};
    const bubbles = Array.from(document.querySelectorAll('[data-msgid$="-answer"], [data-chat-answers-wrap]'));
    const target = scope
      ? bubbles.find((node) => node.getAttribute('data-msgid') === scope)
      : bubbles[bubbles.length - 1];
    if (!target) return [];
    const imgs = Array.from(target.querySelectorAll('img'))
      .map((node) => node.getAttribute('src') || '')
      .filter((src) => src && !src.startsWith('data:') && !/\\.(svg)$/i.test(src) && !src.includes('alicdn.com/imgextra'));
    return Array.from(new Set(imgs));
  })()`);
  return Array.isArray(urls) ? urls.map(String) : [];
}

async function waitForImageUrls(
  page: QwenBrowserPage,
  assistantId: string,
  timeout: number,
): Promise<string[]> {
  const startedAt = Date.now();
  let lastUrls: string[] = [];
  while (Date.now() - startedAt < timeout * 1000) {
    await page.wait(2);
    if (await hasLoginGate(page)) throw new Error("Qwen login is required.");
    const urls = await collectImageUrls(page, assistantId);
    if (
      urls.length &&
      urls.length === lastUrls.length &&
      urls.every((url, i) => url === lastUrls[i])
    ) {
      return urls;
    }
    lastUrls = urls;
  }
  if (lastUrls.length) return lastUrls;
  throw new Error("No generated Qwen images observed before timeout.");
}

async function fetchImageAsset(
  page: QwenBrowserPage,
  url: string,
): Promise<{ mime: string; base64: string }> {
  const result = (await page.evaluate(`(async () => {
    const response = await fetch(${js(url)}, { credentials: 'include' });
    if (!response.ok) return { ok: false, status: response.status };
    const mime = response.headers.get('content-type') || '';
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return { ok: true, mime, base64: btoa(binary) };
  })()`)) as { ok?: boolean; status?: number; mime?: string; base64?: string };
  if (!result?.ok || !result.base64) {
    throw new Error(
      `Failed to fetch generated Qwen image: status=${result?.status ?? "?"}.`,
    );
  }
  return { mime: str(result.mime), base64: result.base64 };
}

cli({
  site: "qwen",
  name: "ask",
  description: "Send a prompt to Qwen and return the assistant reply",
  domain: "www.qianwen.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "prompt", type: "str", required: true, positional: true },
    { name: "timeout", type: "int", default: 120 },
    { name: "new", type: "bool", default: false },
    { name: "think", type: "bool", default: false },
    { name: "research", type: "bool", default: false },
    { name: "markdown", type: "bool", default: false },
  ],
  columns: ["Role", "Text"],
  func: async (page, kwargs) => {
    const prompt = str(kwargs.prompt).trim();
    if (!prompt) throw new Error("Qwen prompt cannot be empty.");
    const p = page as QwenBrowserPage;
    const timeout = qwenBoundedInt(kwargs.timeout, 120, 600, "timeout");
    await ensureOnQwen(p);
    await dismissLoginModal(p);
    if (boolArg(kwargs.new)) await startNewChat(p);
    if (boolArg(kwargs.think)) await setFeatureToggle(p, "think", true);
    if (boolArg(kwargs.research)) await setFeatureToggle(p, "research", true);
    await sendQwenMessage(p, prompt);
    const answer = await waitForQwenAnswer(p, prompt, timeout);
    return [
      { Role: "User", Text: prompt },
      ...mapQwenBubbles([answer], normalizeQwenBoolean(kwargs.markdown)),
    ];
  },
});

cli({
  site: "qwen",
  name: "read",
  description: "Read messages in the current Qwen conversation",
  domain: "www.qianwen.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "markdown", type: "bool", default: false }],
  columns: ["Role", "Text"],
  func: async (page, kwargs) => {
    const p = page as QwenBrowserPage;
    await ensureOnQwen(p);
    await dismissLoginModal(p);
    await p.wait(2);
    const rows = mapQwenBubbles(
      await getMessageBubbles(p),
      normalizeQwenBoolean(kwargs.markdown),
    );
    if (!rows.length) throw new Error("No visible Qwen messages found.");
    return rows;
  },
});

cli({
  site: "qwen",
  name: "send",
  description: "Send a prompt to Qwen without waiting for the reply",
  domain: "www.qianwen.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "prompt", type: "str", required: true, positional: true },
    { name: "new", type: "bool", default: false },
    { name: "think", type: "bool", default: false },
    { name: "research", type: "bool", default: false },
  ],
  columns: ["Status", "Prompt"],
  func: async (page, kwargs) => {
    const prompt = str(kwargs.prompt).trim();
    if (!prompt) throw new Error("Qwen prompt cannot be empty.");
    const p = page as QwenBrowserPage;
    await ensureOnQwen(p);
    await dismissLoginModal(p);
    if (boolArg(kwargs.new)) await startNewChat(p);
    if (boolArg(kwargs.think)) await setFeatureToggle(p, "think", true);
    if (boolArg(kwargs.research)) await setFeatureToggle(p, "research", true);
    await sendQwenMessage(p, prompt);
    return [{ Status: "sent", Prompt: prompt }];
  },
});

cli({
  site: "qwen",
  name: "history",
  description: "List recent Qwen conversations",
  domain: "www.qianwen.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "limit", type: "int", default: 20 }],
  columns: ["Index", "Title", "Updated", "Url"],
  func: async (page, kwargs) => {
    const limit = qwenBoundedInt(kwargs.limit, 20, 100, "history limit");
    const p = page as QwenBrowserPage;
    await ensureOnQwen(p);
    await dismissLoginModal(p);
    return getSessionList(p, limit);
  },
});

cli({
  site: "qwen",
  name: "detail",
  description: "Open a Qwen conversation by ID and read its messages",
  domain: "www.qianwen.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "id", type: "str", required: true, positional: true },
    { name: "markdown", type: "bool", default: false },
  ],
  columns: ["Role", "Text"],
  func: async (page, kwargs) => {
    const p = page as QwenBrowserPage;
    const id = parseQwenSessionId(kwargs.id);
    await p.goto(`${QWEN_HOME}chat/${id}`, {
      waitUntil: "load",
      settleMs: 2500,
    });
    await dismissLoginModal(p);
    const startedAt = Date.now();
    while (Date.now() - startedAt < 20_000) {
      const rows = mapQwenBubbles(
        await getMessageBubbles(p),
        normalizeQwenBoolean(kwargs.markdown),
      );
      if (rows.length) return rows;
      await p.wait(1);
    }
    throw new Error(`No visible Qwen messages found for conversation ${id}.`);
  },
});

cli({
  site: "qwen",
  name: "new",
  description: "Start a new conversation in Qwen",
  domain: "www.qianwen.com",
  strategy: Strategy.COOKIE,
  browser: true,
  columns: ["Status"],
  func: async (page) => {
    const p = page as QwenBrowserPage;
    await p.goto(QWEN_HOME, { waitUntil: "load", settleMs: 2500 });
    await dismissLoginModal(p);
    await startNewChat(p);
    return [{ Status: "New chat started" }];
  },
});

cli({
  site: "qwen",
  name: "status",
  description:
    "Check Qwen page availability, login state, current session and model",
  domain: "www.qianwen.com",
  strategy: Strategy.COOKIE,
  browser: true,
  columns: ["Status", "Login", "Model", "SessionId", "Url"],
  func: async (page) => {
    const p = page as QwenBrowserPage;
    await ensureOnQwen(p);
    await p.wait(2);
    const [loggedIn, sessionId, model, url] = await Promise.all([
      isLoggedIn(p),
      p.evaluate(`(() => {
        const match = window.location.href.match(/\\/chat\\/([A-Za-z0-9_-]+)/);
        return match ? match[1] : '';
      })()`),
      p.evaluate(`(() => {
        ${VISIBLE_JS}
        const trigger = Array.from(document.querySelectorAll('[aria-haspopup=dialog]'))
          .find((node) => isVisible(node) && (node.innerText || '').includes('Qwen'));
        return trigger ? (trigger.innerText || '').split('\\n')[0].trim() : '';
      })()`),
      currentUrl(p),
    ]);
    return [
      {
        Status: "Connected",
        Login: loggedIn ? "Yes" : "No (guest mode)",
        Model: str(model) || null,
        SessionId: str(sessionId) || null,
        Url: url,
      },
    ];
  },
});

cli({
  site: "qwen",
  name: "image",
  description: "Generate images with Qwen and save them locally",
  domain: "www.qianwen.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "prompt", type: "str", required: true, positional: true },
    { name: "op", type: "str", default: "~/Pictures/qianwen" },
    { name: "new", type: "bool", default: true },
    { name: "sd", type: "bool", default: false },
    { name: "timeout", type: "int", default: 180 },
  ],
  columns: ["Status", "File", "Link"],
  func: async (page, kwargs) => {
    const prompt = str(kwargs.prompt).trim();
    if (!prompt) throw new Error("Qwen image prompt cannot be empty.");
    const p = page as QwenBrowserPage;
    const timeout = qwenBoundedInt(kwargs.timeout, 180, 600, "image timeout");
    await ensureOnQwen(p);
    await dismissLoginModal(p);
    if (normalizeQwenBoolean(kwargs.new, true)) await startNewChat(p);
    await setFeatureToggle(p, "image", true);
    await sendQwenMessage(p, prompt);
    let assistantId = "";
    for (let i = 0; i < 5; i += 1) {
      await p.wait(1);
      const assistant = [...(await getMessageBubbles(p))]
        .reverse()
        .find((bubble) => bubble.role === "Assistant");
      if (assistant) {
        assistantId = str(assistant.id);
        break;
      }
    }
    const link = await currentUrl(p);
    if (boolArg(kwargs.sd))
      return [{ Status: "generated", File: null, Link: link }];
    const urls = await waitForImageUrls(p, assistantId, timeout);
    const outputDir = qwenOutputDir(kwargs.op);
    mkdirSync(outputDir, { recursive: true });
    const stamp = Date.now();
    const rows: Record<string, unknown>[] = [];
    for (const [index, url] of urls.entries()) {
      const asset = await fetchImageAsset(p, url);
      const suffix = urls.length > 1 ? `_${index + 1}` : "";
      const filePath = join(
        outputDir,
        `qwen_${stamp}${suffix}${qwenImageExt(asset.mime)}`,
      );
      writeFileSync(filePath, Buffer.from(asset.base64, "base64"));
      rows.push({ Status: "saved", File: displayPath(filePath), Link: link });
    }
    if (!rows.length)
      throw new Error("No generated Qwen images were available to download.");
    return rows;
  },
});
