/**
 * @owner   src/adapters/yuanbao/web.ts
 * @does    Register agent-facing Yuanbao web conversation commands implemented with site-specific safety checks.
 * @needs   Logged-in yuanbao.tencent.com browser session, Yuanbao chat DOM, complete agent/session identifiers.
 * @feeds   surface coverage ledger, Yuanbao read/send/history/detail/status workflows.
 * @breaks  Yuanbao DOM selector drift or accepting bare UUIDs can read/send the wrong session.
 */

import { cli, Strategy } from "../../registry.js";
import { intArg, js, str } from "../_shared/browser-tools.js";

const YUANBAO_HOME = "https://yuanbao.tencent.com/";
const AGENT_ID_RE = /^[A-Za-z0-9_-]{4,40}$/;
const CONV_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VISIBLE_JS = `const isVisible = (node) => {
  if (!(node instanceof HTMLElement)) return false;
  const rect = node.getBoundingClientRect();
  const style = window.getComputedStyle(node);
  return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
};`;

interface YuanbaoBrowserPage {
  goto: (url: string, opts?: Record<string, unknown>) => Promise<unknown>;
  wait: (args: unknown) => Promise<unknown>;
  evaluate: (script: string) => Promise<unknown>;
}

interface YuanbaoSession {
  agentId: string;
  convId: string;
}

interface YuanbaoBubble {
  role?: unknown;
  text?: unknown;
  html?: unknown;
}

interface YuanbaoSessionRow {
  cid?: unknown;
  agentId?: unknown;
  title?: unknown;
}

export function parseYuanbaoSessionId(value: unknown): YuanbaoSession {
  const raw = str(value).trim();
  if (!raw) {
    throw new Error(
      'Yuanbao id must be a non-empty chat URL or "<agentId>/<convId>" pair.',
    );
  }
  const urlMatch = raw.match(
    /yuanbao\.tencent\.com\/chat\/([A-Za-z0-9_-]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i,
  );
  if (urlMatch?.[1] && urlMatch[2]) {
    return validateYuanbaoSession(urlMatch[1], urlMatch[2], raw);
  }
  const pairMatch = raw.match(/^([A-Za-z0-9_-]+)\/([0-9a-f-]{36})$/i);
  if (pairMatch?.[1] && pairMatch[2]) {
    return validateYuanbaoSession(pairMatch[1], pairMatch[2], raw);
  }
  throw new Error(
    `Invalid Yuanbao session reference: ${raw}. Pass https://yuanbao.tencent.com/chat/<agentId>/<convId> or "<agentId>/<convId>"; a UUID alone is not enough.`,
  );
}

function validateYuanbaoSession(
  agentId: string,
  convId: string,
  source: string,
): YuanbaoSession {
  if (!AGENT_ID_RE.test(agentId) || !CONV_ID_RE.test(convId)) {
    throw new Error(`Invalid Yuanbao session reference: ${source}.`);
  }
  return { agentId, convId: convId.toLowerCase() };
}

function yuanbaoSessionUrl(session: YuanbaoSession): string {
  return `${YUANBAO_HOME}chat/${session.agentId}/${session.convId}`;
}

export function yuanbaoHtmlToMarkdown(value: unknown): string {
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

export function mapYuanbaoBubbles(
  bubbles: YuanbaoBubble[],
): Record<string, unknown>[] {
  return bubbles
    .map((bubble) => {
      const role = str(bubble.role) === "Assistant" ? "Assistant" : "User";
      const text =
        role === "Assistant" && str(bubble.html).trim()
          ? yuanbaoHtmlToMarkdown(bubble.html) || str(bubble.text)
          : str(bubble.text);
      return {
        Role: role,
        Text: text.trim(),
      };
    })
    .filter((row) => row.Text);
}

export function mapYuanbaoSessions(
  sessions: YuanbaoSessionRow[],
): Record<string, unknown>[] {
  return sessions
    .map((session, index) => {
      const cid = str(session.cid).toLowerCase();
      const agentId = str(session.agentId);
      return {
        Index: index + 1,
        Title: str(session.title, "(untitled)").trim() || "(untitled)",
        AgentId: agentId,
        SessionId: cid,
        Url: `${YUANBAO_HOME}chat/${agentId}/${cid}`,
      };
    })
    .filter(
      (row) =>
        AGENT_ID_RE.test(str(row.AgentId)) &&
        CONV_ID_RE.test(str(row.SessionId)),
    );
}

async function currentUrl(page: YuanbaoBrowserPage): Promise<string> {
  const value = await page.evaluate("window.location.href").catch(() => "");
  return typeof value === "string" ? value : "";
}

async function ensureYuanbaoPage(page: YuanbaoBrowserPage): Promise<void> {
  const url = await currentUrl(page);
  let onYuanbao = false;
  try {
    const hostname = new URL(url).hostname;
    onYuanbao =
      hostname === "yuanbao.tencent.com" ||
      hostname.endsWith(".yuanbao.tencent.com");
  } catch {
    onYuanbao = false;
  }
  if (!onYuanbao) {
    await page.goto(YUANBAO_HOME, { waitUntil: "load", settleMs: 2500 });
    await page.wait(1);
  }
}

async function hasLoginGate(page: YuanbaoBrowserPage): Promise<boolean> {
  const result = await page.evaluate(`(() => {
    const bodyText = document.body?.innerText || '';
    const hasWechatLoginText = bodyText.includes('微信扫码登录');
    const hasWechatIframe = Array.from(document.querySelectorAll('iframe'))
      .some((frame) => (frame.getAttribute('src') || '').includes('open.weixin.qq.com/connect/qrconnect'));
    return hasWechatLoginText || hasWechatIframe;
  })()`);
  return Boolean(result);
}

async function readBubbles(page: YuanbaoBrowserPage): Promise<YuanbaoBubble[]> {
  const result = await page.evaluate(`(() => {
    ${VISIBLE_JS}
    const items = Array.from(document.querySelectorAll('.agent-chat__list__item--human, .agent-chat__list__item--ai'))
      .filter((node) => isVisible(node));
    return items.map((node) => {
      const isAi = node.classList.contains('agent-chat__list__item--ai');
      const contentNode = isAi
        ? (node.querySelector('.hyc-content-md-done')
          || node.querySelector('.hyc-content-md')
          || node.querySelector('.agent-chat__speech-text')
          || node.querySelector('.agent-chat__bubble__content'))
        : (node.querySelector('.hyc-component-text .hyc-content-text')
          || node.querySelector('.hyc-content-text')
          || node.querySelector('.agent-chat__bubble__content'));
      const html = contentNode instanceof HTMLElement ? (contentNode.innerHTML || '') : '';
      const text = contentNode instanceof HTMLElement
        ? (contentNode.innerText || contentNode.textContent || '')
        : ((node.innerText || node.textContent) || '');
      return {
        role: isAi ? 'Assistant' : 'User',
        text: String(text || '').replace(/\\u00a0/g, ' ').trim(),
        html,
      };
    });
  })()`);
  return Array.isArray(result) ? (result as YuanbaoBubble[]) : [];
}

async function readCurrentConversation(
  page: YuanbaoBrowserPage,
): Promise<Record<string, unknown>[]> {
  await ensureYuanbaoPage(page);
  await page.wait(1.5);
  if (await hasLoginGate(page)) {
    throw new Error("Yuanbao login is required before reading messages.");
  }
  const rows = mapYuanbaoBubbles(await readBubbles(page));
  if (!rows.length) throw new Error("No visible Yuanbao messages found.");
  return rows;
}

async function listSessions(
  page: YuanbaoBrowserPage,
  limit: number,
): Promise<Record<string, unknown>[]> {
  await ensureYuanbaoPage(page);
  if (await hasLoginGate(page)) {
    throw new Error("Yuanbao login is required before reading history.");
  }
  await page.wait(1.5);
  const raw = await page.evaluate(`(() => {
    ${VISIBLE_JS}
    const nodes = Array.from(document.querySelectorAll('.yb-recent-conv-list__item'))
      .filter((node) => isVisible(node));
    return nodes.map((node) => {
      const cid = node.getAttribute('dt-cid') || '';
      const agentId = node.getAttribute('dt-agent-id') || '';
      const titleEl = node.querySelector('[data-item-name]');
      const title = (titleEl?.getAttribute('data-item-name') || titleEl?.textContent || '').trim();
      return { cid, agentId, title };
    });
  })()`);
  const rows = Array.isArray(raw)
    ? mapYuanbaoSessions(raw as YuanbaoSessionRow[])
    : [];
  if (!rows.length)
    throw new Error("No Yuanbao conversations found in the sidebar.");
  return rows.slice(0, limit);
}

async function sendYuanbaoPrompt(
  page: YuanbaoBrowserPage,
  prompt: string,
): Promise<Record<string, unknown>> {
  const result = (await page.evaluate(`(async () => {
    const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    ${VISIBLE_JS}
    const composer = Array.from(document.querySelectorAll('.ql-editor[contenteditable="true"], .ql-editor, [contenteditable="true"]'))
      .find(isVisible);
    if (!(composer instanceof HTMLElement)) return { ok: false, reason: 'Yuanbao composer was not found.' };
    composer.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    composer.textContent = '';
    document.execCommand('insertText', false, ${js(prompt)});
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${js(prompt)}, inputType: 'insertText' }));
    const findEnabledSubmit = () => Array.from(document.querySelectorAll('a[class*="send-btn"], button[class*="send-btn"], button[class*="submit"]'))
      .find((node) => {
        if (!(node instanceof HTMLElement) || !isVisible(node)) return false;
        const className = typeof node.className === 'string' ? node.className : '';
        return !className.includes('send-btn--disabled') && !className.includes('disabled');
      });
    let submit = null;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      submit = findEnabledSubmit();
      if (submit) break;
      await waitFor(150);
    }
    if (submit instanceof HTMLElement) {
      submit.click();
      return { ok: true, action: 'click' };
    }
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    composer.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    return { ok: true, action: 'enter' };
  })()`)) as Record<string, unknown>;
  if (!result?.ok) {
    throw new Error(str(result?.reason, "Failed to send Yuanbao prompt."));
  }
  return result;
}

cli({
  site: "yuanbao",
  name: "read",
  description: "Read messages in the current Yuanbao conversation",
  domain: "yuanbao.tencent.com",
  strategy: Strategy.COOKIE,
  browser: true,
  columns: ["Role", "Text"],
  func: async (page) => readCurrentConversation(page as YuanbaoBrowserPage),
});

cli({
  site: "yuanbao",
  name: "send",
  description: "Send a prompt to Yuanbao without waiting for the reply",
  domain: "yuanbao.tencent.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "prompt", type: "str", required: true, positional: true },
    { name: "new", type: "bool", default: false },
  ],
  columns: ["Status", "Prompt"],
  func: async (page, kwargs) => {
    const prompt = str(kwargs.prompt).trim();
    if (!prompt) throw new Error("Yuanbao prompt cannot be empty.");
    const p = page as YuanbaoBrowserPage;
    await ensureYuanbaoPage(p);
    if (await hasLoginGate(p)) {
      throw new Error("Yuanbao login is required before sending prompts.");
    }
    if (kwargs.new === true || kwargs.new === "true" || kwargs.new === "1") {
      await p.goto(YUANBAO_HOME, { waitUntil: "load", settleMs: 2500 });
      await p.wait(1);
    }
    await sendYuanbaoPrompt(p, prompt);
    return [{ Status: "sent", Prompt: prompt }];
  },
});

cli({
  site: "yuanbao",
  name: "history",
  description: "List recent Yuanbao conversations from the sidebar",
  domain: "yuanbao.tencent.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "limit", type: "int", default: 20 }],
  columns: ["Index", "Title", "AgentId", "SessionId", "Url"],
  func: async (page, kwargs) => {
    const limit = intArg(kwargs.limit, 20, 100);
    return listSessions(page as YuanbaoBrowserPage, limit);
  },
});

cli({
  site: "yuanbao",
  name: "detail",
  description: "Open a Yuanbao conversation by ID and read its messages",
  domain: "yuanbao.tencent.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "id", type: "str", required: true, positional: true }],
  columns: ["Role", "Text"],
  func: async (page, kwargs) => {
    const p = page as YuanbaoBrowserPage;
    const session = parseYuanbaoSessionId(kwargs.id);
    await p.goto(yuanbaoSessionUrl(session), {
      waitUntil: "load",
      settleMs: 2500,
    });
    await p.wait(2);
    if (await hasLoginGate(p)) {
      throw new Error("Yuanbao login is required before reading detail.");
    }
    const startedAt = Date.now();
    while (Date.now() - startedAt < 20_000) {
      const rows = mapYuanbaoBubbles(await readBubbles(p));
      if (rows.length) return rows;
      await p.wait(1);
    }
    throw new Error(
      `No visible Yuanbao messages found for conversation ${session.agentId}/${session.convId}.`,
    );
  },
});

cli({
  site: "yuanbao",
  name: "status",
  description:
    "Check Yuanbao page availability, login state, current session and model",
  domain: "yuanbao.tencent.com",
  strategy: Strategy.COOKIE,
  browser: true,
  columns: [
    "Status",
    "Login",
    "Model",
    "ModelId",
    "AgentId",
    "SessionId",
    "Url",
  ],
  func: async (page) => {
    const p = page as YuanbaoBrowserPage;
    await ensureYuanbaoPage(p);
    await p.wait(1.5);
    const [loginGate, session, model, url] = await Promise.all([
      hasLoginGate(p),
      p.evaluate(`(() => {
        const match = window.location.href.match(/yuanbao\\.tencent\\.com\\/chat\\/([A-Za-z0-9_-]+)\\/([0-9a-f-]{36})(?:[/?#]|$)/i);
        if (!match) return null;
        return { agentId: match[1], convId: match[2].toLowerCase() };
      })()`),
      p.evaluate(`(() => {
        const button = document.querySelector('[dt-button-id="model_switch"]');
        if (!(button instanceof HTMLElement)) return { label: null, modelId: null };
        const label = (button.querySelector('.t-button__text')?.textContent || button.textContent || '').trim() || null;
        const modelId = button.getAttribute('dt-model-id') || null;
        return { label, modelId };
      })()`),
      currentUrl(p),
    ]);
    const typedSession =
      session && typeof session === "object"
        ? (session as { agentId?: unknown; convId?: unknown })
        : null;
    const typedModel =
      model && typeof model === "object"
        ? (model as { label?: unknown; modelId?: unknown })
        : null;
    return [
      {
        Status: "Connected",
        Login: loginGate ? "No (login gate)" : "Yes",
        Model: typedModel?.label ?? null,
        ModelId: typedModel?.modelId ?? null,
        AgentId: typedSession?.agentId ?? null,
        SessionId: typedSession?.convId ?? null,
        Url: url,
      },
    ];
  },
});
