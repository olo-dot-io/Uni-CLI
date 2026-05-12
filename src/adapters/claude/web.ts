/**
 * @owner   src/adapters/claude/web.ts
 * @does    Register agent-facing Claude web chat commands implemented with site-specific safety checks.
 * @needs   Logged-in claude.ai browser session, Claude chat DOM, optional local file upload path.
 * @feeds   surface coverage ledger and Claude ask/read/send/history/detail/new/status workflows.
 * @breaks  Claude DOM drift, login redirects, or invalid conversation IDs can block chat automation.
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { js, str } from "../_shared/browser-tools.js";

const CLAUDE_HOME = "https://claude.ai";
const CLAUDE_NEW = `${CLAUDE_HOME}/new`;
const COMPOSER_SELECTOR = '[data-testid="chat-input"]';
const MESSAGE_SELECTOR = ".font-claude-response";
const MODEL_DROPDOWN_SELECTOR = '[data-testid="model-selector-dropdown"]';
const FILE_INPUT_SELECTOR = 'input[data-testid="file-upload"]';
const CONVERSATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  sonnet: "Sonnet 4.6",
  opus: "Opus 4.7",
  haiku: "Haiku 4.5",
};

interface ClaudePageState {
  url?: unknown;
  title?: unknown;
  hasComposer?: unknown;
  isLoggedIn?: unknown;
}

interface ClaudeMessage {
  role?: unknown;
  text?: unknown;
}

interface ClaudeConversation {
  Id?: unknown;
  Title?: unknown;
  Url?: unknown;
}

export function normalizeClaudeBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return str(value).trim().toLowerCase() === "true";
}

export function requireClaudePrompt(value: unknown, label: string): string {
  const prompt = str(value).trim();
  if (!prompt) throw new Error(`${label} prompt cannot be empty.`);
  return prompt;
}

export function requireClaudePositiveInt(
  value: unknown,
  fallback: number,
  label: string,
): number {
  const raw = value ?? fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return n;
}

export function parseClaudeConversationId(value: unknown): string {
  const raw = str(value).trim();
  if (!raw) throw new Error("Claude conversation ID cannot be empty.");
  const urlMatch = raw.match(/claude\.ai\/chat\/([0-9a-f-]{36})(?:[/?#]|$)/i);
  const candidate = urlMatch?.[1] ?? raw;
  if (!CONVERSATION_ID_RE.test(candidate)) {
    throw new Error(
      `Invalid Claude conversation ID: ${raw}. Expected UUID or https://claude.ai/chat/<uuid>.`,
    );
  }
  return candidate.toLowerCase();
}

export function mapClaudeMessages(
  messages: ClaudeMessage[],
): Record<string, unknown>[] {
  return messages
    .map((message, index) => ({
      Index: index + 1,
      Role: str(message.role),
      Text: str(message.text).trim(),
    }))
    .filter((row) => row.Text);
}

export function mapClaudeConversations(
  conversations: ClaudeConversation[],
  limit: number,
): Record<string, unknown>[] {
  return conversations
    .map((conversation, index) => ({
      Index: index + 1,
      Id: str(conversation.Id),
      Title: str(conversation.Title, "(untitled)").trim() || "(untitled)",
      Url: str(conversation.Url),
    }))
    .filter((row) => row.Id && row.Url)
    .slice(0, limit);
}

async function currentUrl(page: IPage): Promise<string> {
  const value = await page.evaluate("window.location.href").catch(() => "");
  return typeof value === "string" ? value : "";
}

async function ensureOnClaude(page: IPage): Promise<boolean> {
  const url = await currentUrl(page);
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "claude.ai" || host.endsWith(".claude.ai")) return false;
  } catch {
    await page.goto(CLAUDE_NEW, { waitUntil: "load", settleMs: 2500 });
    try {
      await page.waitForSelector(COMPOSER_SELECTOR, 8);
    } catch {
      return true;
    }
    return true;
  }
  await page.goto(CLAUDE_NEW, { waitUntil: "load", settleMs: 2500 });
  try {
    await page.waitForSelector(COMPOSER_SELECTOR, 8);
  } catch {
    return true;
  }
  return true;
}

async function getPageState(page: IPage): Promise<ClaudePageState> {
  const state = await page.evaluate(`(() => {
    const composer = document.querySelector(${js(COMPOSER_SELECTOR)});
    const userMenu = document.querySelector('[data-testid="user-menu-button"]');
    return {
      url: window.location.href,
      title: document.title,
      hasComposer: Boolean(composer),
      isLoggedIn: Boolean(userMenu),
    };
  })()`);
  return typeof state === "object" && state !== null
    ? (state as ClaudePageState)
    : {};
}

async function ensureClaudeLogin(
  page: IPage,
  message: string,
): Promise<ClaudePageState> {
  const state = await getPageState(page);
  if (!state.isLoggedIn) throw new Error(message);
  return state;
}

async function ensureClaudeComposer(
  page: IPage,
  message: string,
): Promise<ClaudePageState> {
  const state = await ensureClaudeLogin(page, message);
  if (!state.hasComposer) throw new Error(message);
  return state;
}

async function readVisibleMessages(
  page: IPage,
): Promise<Record<string, unknown>[]> {
  const result = await page.evaluate(`(() => {
    const nodes = document.querySelectorAll('[data-testid="user-message"], ${MESSAGE_SELECTOR}');
    const rows = [];
    Array.from(nodes).forEach((el) => {
      const isUser = el.getAttribute('data-testid') === 'user-message';
      let raw = (el.innerText || '').trim();
      if (!isUser) {
        const parts = raw.split(/\\n\\n+/);
        while (parts.length > 1 && /^(Thought|View)\\b/i.test(parts[0])) parts.shift();
        raw = parts.join('\\n\\n').trim();
      }
      if (raw) rows.push({ role: isUser ? 'user' : 'assistant', text: raw });
    });
    return rows;
  })()`);
  const rows = Array.isArray(result) ? (result as ClaudeMessage[]) : [];
  return mapClaudeMessages(rows);
}

async function getConversationList(
  page: IPage,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const url = await currentUrl(page);
  if (!url.includes("/recents")) {
    await page.goto(`${CLAUDE_HOME}/recents`, {
      waitUntil: "load",
      settleMs: 2500,
    });
    try {
      await page.waitForSelector('a[href*="/chat/"]', 8);
    } catch {
      await page.wait(0.5);
    }
  }
  const result = await page.evaluate(`(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/chat/"]'));
    const seen = new Set();
    const rows = [];
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const idMatch = href.match(/\\/chat\\/([a-f0-9-]{36})/i);
      if (!idMatch || seen.has(idMatch[1])) continue;
      seen.add(idMatch[1]);
      rows.push({
        Id: idMatch[1].toLowerCase(),
        Title: (link.innerText || '').trim().split('\\n')[0].trim() || '(untitled)',
        Url: href.startsWith('http') ? href : (${js(CLAUDE_HOME)} + href),
      });
    }
    return rows;
  })()`);
  const rows = mapClaudeConversations(
    Array.isArray(result) ? (result as ClaudeConversation[]) : [],
    limit,
  );
  if (!rows.length)
    throw new Error("No Claude conversation history was visible on /recents.");
  return rows;
}

async function selectModel(
  page: IPage,
  modelName: unknown,
): Promise<{ ok?: boolean; upgrade?: boolean }> {
  const key = str(modelName, "sonnet").toLowerCase();
  const display = MODEL_DISPLAY_NAMES[key];
  if (!display) return { ok: false };
  const opened = (await page.evaluate(`(() => {
    const trigger = document.querySelector(${js(MODEL_DROPDOWN_SELECTOR)});
    if (!trigger) return { ok: false };
    const label = trigger.getAttribute('aria-label') || '';
    if (label.includes(${js(display)})) return { ok: true };
    trigger.click();
    return { ok: true, opened: true };
  })()`)) as { ok?: boolean; opened?: boolean };
  if (!opened?.ok || !opened.opened) return opened;
  try {
    await page.waitForSelector('div[role="menuitemradio"]', 3);
  } catch {
    await page.wait(0.3);
  }
  return (await page.evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('div[role="menuitemradio"]'));
    const target = items.find((el) => (el.innerText || '').includes(${js(display)}));
    if (!target) return { ok: false };
    const upgrade = target.querySelector('button');
    if (upgrade && (upgrade.innerText || '').toLowerCase().includes('upgrade')) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { ok: false, upgrade: true };
    }
    if (target.getAttribute('aria-checked') !== 'true') target.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { ok: true };
  })()`)) as { ok?: boolean; upgrade?: boolean };
}

async function setAdaptiveThinking(
  page: IPage,
  enabled: boolean,
): Promise<{ ok?: boolean }> {
  const opened = (await page.evaluate(`(() => {
    const trigger = document.querySelector(${js(MODEL_DROPDOWN_SELECTOR)});
    if (!trigger) return { ok: false };
    trigger.click();
    return { ok: true };
  })()`)) as { ok?: boolean };
  if (!opened?.ok) return { ok: false };
  try {
    await page.waitForSelector('div[role="menuitem"]', 3);
  } catch {
    await page.wait(0.3);
  }
  return (await page.evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('div[role="menuitem"]'));
    const target = items.find((el) => (el.innerText || '').includes('Adaptive thinking'));
    if (!target) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { ok: false };
    }
    const isActive = target.getAttribute('aria-checked') === 'true';
    if (${JSON.stringify(enabled)} !== isActive) target.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { ok: true };
  })()`)) as { ok?: boolean };
}

async function sendMessage(
  page: IPage,
  prompt: string,
): Promise<{ ok?: boolean; method?: string; reason?: string }> {
  const composerReady = await page.evaluate(`(() => {
    const box = document.querySelector(${js(COMPOSER_SELECTOR)});
    if (!box) return false;
    box.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(box);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand('delete', false);
    return true;
  })()`);
  if (!composerReady) return { ok: false, reason: "composer not found" };
  await page.insertText(prompt);
  await page.wait(1.2);
  return (await page.evaluate(`(() => {
    const ariaCandidates = [
      'button[aria-label="Send Message"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send"]',
      'button[aria-label*="Send"]',
    ];
    for (const selector of ariaCandidates) {
      const button = document.querySelector(selector);
      if (button && !button.disabled) {
        button.click();
        return { ok: true, method: 'send-button' };
      }
    }
    return { ok: false, reason: 'send button not found' };
  })()`)) as { ok?: boolean; method?: string; reason?: string };
}

async function getBubbleCount(page: IPage): Promise<number> {
  const count = await page.evaluate(
    `document.querySelectorAll(${js(MESSAGE_SELECTOR)}).length`,
  );
  return Number(count) || 0;
}

async function waitForResponse(
  page: IPage,
  baselineCount: number,
  prompt: string,
  timeoutMs: number,
): Promise<string | null> {
  const startedAt = Date.now();
  let lastText = "";
  let stableCount = 0;
  while (Date.now() - startedAt < timeoutMs) {
    await page.wait(3);
    const result = (await page.evaluate(`(() => {
      const bubbles = document.querySelectorAll(${js(MESSAGE_SELECTOR)});
      const texts = Array.from(bubbles).map((bubble) => {
        let raw = (bubble.innerText || '').trim();
        const parts = raw.split(/\\n\\n+/);
        while (parts.length > 1 && /^(Thought|View)\\b/i.test(parts[0])) parts.shift();
        return parts.join('\\n\\n').trim();
      }).filter(Boolean);
      return {
        count: texts.length,
        last: texts[texts.length - 1] || '',
        streaming: Boolean(document.querySelector('[data-is-streaming="true"]')),
      };
    })()`)) as { count?: number; last?: string; streaming?: boolean };
    const candidate = str(result?.last).trim();
    if (
      !candidate ||
      candidate === prompt.trim() ||
      Number(result?.count) <= baselineCount
    )
      continue;
    if (result?.streaming) {
      lastText = candidate;
      stableCount = 0;
      continue;
    }
    if (candidate === lastText) {
      stableCount += 1;
      if (stableCount >= 3) return candidate;
    } else {
      stableCount = 0;
      lastText = candidate;
    }
  }
  return lastText || null;
}

function resolveUploadFile(value: unknown): string {
  const file = resolve(str(value).trim());
  if (!existsSync(file))
    throw new Error(`Claude upload file not found: ${file}`);
  const stats = statSync(file);
  if (stats.size > 30 * 1024 * 1024) {
    throw new Error(
      `Claude upload file is too large (${(stats.size / 1024 / 1024).toFixed(1)} MB). Max: 30 MB.`,
    );
  }
  return file;
}

async function sendWithFile(
  page: IPage,
  fileValue: unknown,
  prompt: string,
): Promise<{ ok?: boolean; method?: string; reason?: string }> {
  const file = resolveUploadFile(fileValue);
  await page.setFileInput(FILE_INPUT_SELECTOR, [file]);
  const ready = await waitForFilePreview(page);
  if (!ready) return { ok: false, reason: "file preview did not appear" };
  return sendMessage(page, prompt);
}

async function waitForFilePreview(page: IPage): Promise<boolean> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await page.wait(1);
    const ready = await page.evaluate(`(() => {
      if (document.querySelector('[data-testid="file-thumbnail"]')) return true;
      return Array.from(document.querySelectorAll('button')).some((button) => (button.getAttribute('aria-label') || '') === 'Remove');
    })()`);
    if (ready) return true;
  }
  return false;
}

async function navigateNew(page: IPage): Promise<void> {
  await page.goto(CLAUDE_NEW, { waitUntil: "load", settleMs: 2500 });
  try {
    await page.waitForSelector(COMPOSER_SELECTOR, 8);
  } catch {
    await page.wait(0.5);
  }
}

async function maybeResumeRecentConversation(page: IPage): Promise<void> {
  const navigated = await ensureOnClaude(page);
  if (!navigated) return;
  await page.evaluate(`(() => {
    const link = document.querySelector('a[href*="/chat/"]');
    if (link instanceof HTMLElement) link.click();
  })()`);
  try {
    await page.waitForSelector(MESSAGE_SELECTOR, 5);
  } catch {
    await page.wait(0.5);
  }
}

cli({
  site: "claude",
  name: "ask",
  description: "Send a prompt to Claude and return the assistant response",
  domain: "claude.ai",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "prompt", type: "str", required: true, positional: true },
    { name: "timeout", type: "int", default: 120 },
    { name: "new", type: "bool", default: false },
    {
      name: "model",
      type: "str",
      default: "sonnet",
      choices: ["sonnet", "opus", "haiku"],
    },
    { name: "think", type: "bool", default: false },
    { name: "file", type: "str" },
  ],
  columns: ["response"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const prompt = requireClaudePrompt(kwargs.prompt, "Claude ask");
    const timeoutSeconds = requireClaudePositiveInt(
      kwargs.timeout,
      120,
      "Claude ask timeout",
    );
    const wantThink = normalizeClaudeBoolean(kwargs.think);
    if (normalizeClaudeBoolean(kwargs.new)) await navigateNew(p);
    else await maybeResumeRecentConversation(p);
    await ensureClaudeComposer(
      p,
      "Claude ask requires a visible composer in a logged-in Claude session.",
    );
    const current = await currentUrl(p);
    const inConversation = current.includes("/chat/");
    const model = str(kwargs.model, "sonnet").toLowerCase();
    if (inConversation && kwargs.model && kwargs.model !== "sonnet") {
      throw new Error(
        `Cannot switch to ${model} model inside an existing Claude conversation. Start with --new.`,
      );
    }
    if (!inConversation) {
      const modelResult = await selectModel(p, model);
      if (!modelResult?.ok) {
        if (modelResult?.upgrade)
          throw new Error(`${model} model requires a paid Claude plan.`);
        throw new Error(`Could not switch to Claude ${model} model.`);
      }
    }
    const thinkResult = await setAdaptiveThinking(p, wantThink);
    if (!thinkResult?.ok && wantThink)
      throw new Error("Could not enable Claude Adaptive thinking.");
    const baseline = await getBubbleCount(p);
    const sendResult = kwargs.file
      ? await sendWithFile(p, kwargs.file, prompt)
      : await sendMessage(p, prompt);
    if (!sendResult?.ok)
      throw new Error(sendResult?.reason || "Failed to send Claude message.");
    const response = await waitForResponse(
      p,
      baseline,
      prompt,
      timeoutSeconds * 1000,
    );
    if (!response)
      throw new Error(`No Claude response appeared within ${timeoutSeconds}s.`);
    return [{ response }];
  },
});

cli({
  site: "claude",
  name: "send",
  description: "Send a prompt to Claude without waiting for a response",
  domain: "claude.ai",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "prompt", type: "str", required: true, positional: true },
    { name: "new", type: "bool", default: false },
  ],
  columns: ["Status", "SubmittedBy", "InjectedText"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const prompt = requireClaudePrompt(kwargs.prompt, "Claude send");
    if (normalizeClaudeBoolean(kwargs.new)) await navigateNew(p);
    else await ensureOnClaude(p);
    await ensureClaudeComposer(
      p,
      "Claude send requires a visible composer in a logged-in Claude session.",
    );
    const result = await sendMessage(p, prompt);
    if (!result?.ok)
      throw new Error(result?.reason || "Failed to send Claude message.");
    return [
      {
        Status: "Success",
        SubmittedBy: result.method || "send-button",
        InjectedText: prompt,
      },
    ];
  },
});

cli({
  site: "claude",
  name: "new",
  description: "Start a new conversation in Claude",
  domain: "claude.ai",
  strategy: Strategy.COOKIE,
  browser: true,
  columns: ["Status"],
  func: async (page) => {
    const p = page as IPage;
    await navigateNew(p);
    await ensureClaudeComposer(
      p,
      "Claude new requires a logged-in Claude session with a visible composer.",
    );
    return [{ Status: "New chat started" }];
  },
});

cli({
  site: "claude",
  name: "status",
  description: "Check Claude page availability and login state",
  domain: "claude.ai",
  strategy: Strategy.COOKIE,
  browser: true,
  columns: ["Status", "Login", "Url"],
  func: async (page) => {
    const p = page as IPage;
    await ensureOnClaude(p);
    const state = await getPageState(p);
    return [
      {
        Status: state.hasComposer ? "Connected" : "Page not ready",
        Login: state.isLoggedIn ? "Yes" : "No",
        Url: str(state.url),
      },
    ];
  },
});

cli({
  site: "claude",
  name: "read",
  description: "Read the current Claude conversation",
  domain: "claude.ai",
  strategy: Strategy.COOKIE,
  browser: true,
  columns: ["Index", "Role", "Text"],
  func: async (page) => {
    const p = page as IPage;
    await ensureOnClaude(p);
    await ensureClaudeLogin(
      p,
      "Claude read requires a logged-in Claude session.",
    );
    const rows = await readVisibleMessages(p);
    if (!rows.length)
      throw new Error(
        "No visible Claude messages were found in the current conversation.",
      );
    return rows;
  },
});

cli({
  site: "claude",
  name: "history",
  description: "List conversation history from Claude /recents",
  domain: "claude.ai",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "limit", type: "int", default: 20 }],
  columns: ["Index", "Id", "Title", "Url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const limit = requireClaudePositiveInt(
      kwargs.limit,
      20,
      "Claude history limit",
    );
    const rows = await getConversationList(p, limit);
    await ensureClaudeLogin(
      p,
      "Claude history requires a logged-in Claude session.",
    );
    return rows;
  },
});

cli({
  site: "claude",
  name: "detail",
  description: "Open a Claude conversation by ID and read its messages",
  domain: "claude.ai",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "id", type: "str", required: true, positional: true }],
  columns: ["Index", "Role", "Text"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const id = parseClaudeConversationId(kwargs.id);
    await p.goto(`${CLAUDE_HOME}/chat/${id}`, {
      waitUntil: "load",
      settleMs: 2500,
    });
    try {
      await p.waitForSelector(MESSAGE_SELECTOR, 10);
    } catch {
      await p.wait(0.5);
    }
    await ensureClaudeLogin(
      p,
      "Claude detail requires a logged-in Claude session.",
    );
    const rows = await readVisibleMessages(p);
    if (!rows.length)
      throw new Error(
        `No visible Claude messages were found for conversation ${id}.`,
      );
    return rows;
  },
});
