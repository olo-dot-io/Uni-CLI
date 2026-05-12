/**
 * @owner   src/adapters/chatgpt/web.ts
 * @does    Register agent-facing ChatGPT web history and detail readers implemented with site-specific safety checks.
 * @needs   Logged-in chatgpt.com browser session, visible sidebar links, rendered conversation messages.
 * @feeds   surface coverage ledger, ChatGPT conversation discovery, and browser-session read workflows.
 * @breaks  ChatGPT DOM selector drift or login gates can hide history/messages.
 */

import { cli, Strategy } from "../../registry.js";
import { intArg, js, str } from "../_shared/browser-tools.js";

const CHATGPT_HOME = "https://chatgpt.com";
const CONVERSATION_LINK_SELECTOR = 'a[href*="/c/"]';
const CONVERSATION_MESSAGE_SELECTOR =
  '[data-message-author-role], article[data-testid*="conversation-turn"]';

interface RawChatGptConversation {
  Id?: unknown;
  Title?: unknown;
  Url?: unknown;
}

interface RawChatGptMessage {
  role?: unknown;
  text?: unknown;
  html?: unknown;
}

interface ChatGptBrowserPage {
  goto: (url: string, opts?: Record<string, unknown>) => Promise<unknown>;
  wait: (args: unknown) => Promise<unknown>;
  evaluate: (script: string) => Promise<unknown>;
}

export function parseChatGptConversationId(value: unknown): string {
  const raw = str(value).trim();
  const match = raw.match(/(?:^|\/c\/)([A-Za-z0-9_-]{8,})(?:[/?#]|$)/);
  if (match?.[1]) return match[1];
  if (/^[A-Za-z0-9_-]{8,}$/.test(raw)) return raw;
  throw new Error("chatgpt detail requires a conversation id or /c/<id> URL.");
}

export function normalizeChatGptBoolean(
  value: unknown,
  fallback = false,
): boolean {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null || value === "") return fallback;
  return /^(true|1|yes|on)$/i.test(str(value).trim());
}

export function chatGptHtmlToMarkdown(value: unknown): string {
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

export function mapChatGptConversations(
  items: RawChatGptConversation[],
): Record<string, unknown>[] {
  return items
    .map((item, index) => ({
      Index: index + 1,
      Id: str(item.Id),
      Title: str(item.Title, "(untitled)").trim() || "(untitled)",
      Url: str(item.Url),
    }))
    .filter((item) => item.Id);
}

export function mapChatGptMessages(
  items: RawChatGptMessage[],
  wantMarkdown: boolean,
): Record<string, unknown>[] {
  return items
    .map((item, index) => {
      const role = /assistant/i.test(str(item.role)) ? "Assistant" : "User";
      const text =
        wantMarkdown && role === "Assistant" && str(item.html).trim()
          ? chatGptHtmlToMarkdown(item.html)
          : str(item.text).trim();
      return {
        Index: index + 1,
        Role: role,
        Text: text,
      };
    })
    .filter((item) => item.Text);
}

async function openChatGpt(page: ChatGptBrowserPage): Promise<void> {
  await page.goto(CHATGPT_HOME, { settleMs: 2000 });
}

async function readConversationLinks(
  page: ChatGptBrowserPage,
): Promise<RawChatGptConversation[]> {
  const rows = await page.evaluate(`(() => {
    const isVisible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const links = Array.from(document.querySelectorAll(${js(CONVERSATION_LINK_SELECTOR)}))
      .filter((link) => link instanceof HTMLAnchorElement && isVisible(link));
    const seen = new Set();
    const items = [];
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/\\/c\\/([^/?#]+)/);
      if (!match || seen.has(match[1])) continue;
      seen.add(match[1]);
      items.push({
        Id: match[1],
        Title: (link.innerText || link.textContent || '').replace(/\\s+/g, ' ').trim() || '(untitled)',
        Url: href.startsWith('http') ? href : (${js(CHATGPT_HOME)} + href),
      });
    }
    return items;
  })()`);
  return Array.isArray(rows) ? (rows as RawChatGptConversation[]) : [];
}

async function openSidebar(page: ChatGptBrowserPage): Promise<void> {
  const opened = await page.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button'))
      .find((node) => /open sidebar|打开边栏|打开侧边栏/i.test(node.getAttribute('aria-label') || ''));
    if (button instanceof HTMLElement) {
      button.click();
      return true;
    }
    return false;
  })()`);
  if (opened) {
    try {
      await page.wait({ selector: CONVERSATION_LINK_SELECTOR, timeout: 3 });
    } catch {
      return;
    }
  }
}

async function getConversationHistory(
  page: ChatGptBrowserPage,
  limit: number,
): Promise<Record<string, unknown>[]> {
  await openChatGpt(page);
  await openSidebar(page);
  let rows = mapChatGptConversations(await readConversationLinks(page));
  if (!rows.length) {
    await page.goto(CHATGPT_HOME, { settleMs: 2000 });
    try {
      await page.wait({ selector: CONVERSATION_LINK_SELECTOR, timeout: 8 });
    } catch {
      rows = [];
    }
    rows = mapChatGptConversations(await readConversationLinks(page));
  }
  if (!rows.length) {
    throw new Error(
      "No ChatGPT conversation links were visible in the sidebar.",
    );
  }
  return rows.slice(0, limit);
}

async function readVisibleMessages(
  page: ChatGptBrowserPage,
  wantMarkdown: boolean,
): Promise<Record<string, unknown>[]> {
  const rows = await page.evaluate(`(() => {
    const isVisible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const normalize = (value) => String(value || '').replace(/\\u00a0/g, ' ').replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
    const roleOf = (node) => {
      const attr = node.getAttribute('data-message-author-role') || node.getAttribute('data-author') || '';
      if (/assistant/i.test(attr)) return 'Assistant';
      if (/user/i.test(attr)) return 'User';
      const testid = node.getAttribute('data-testid') || '';
      if (/assistant/i.test(testid)) return 'Assistant';
      if (/user/i.test(testid)) return 'User';
      const label = node.getAttribute('aria-label') || '';
      if (/assistant|chatgpt/i.test(label)) return 'Assistant';
      if (/you|user/i.test(label)) return 'User';
      return '';
    };
    const nodes = Array.from(document.querySelectorAll(${js(CONVERSATION_MESSAGE_SELECTOR)}))
      .filter((node) => node instanceof HTMLElement && isVisible(node));
    const seen = new Set();
    const items = [];
    for (const node of nodes) {
      let role = roleOf(node);
      const roleNode = node.querySelector('[data-message-author-role], [data-author]');
      if (!role && roleNode) role = roleOf(roleNode);
      if (!role) continue;
      const contentNode = node.querySelector('[data-message-author-role] .markdown')
        || node.querySelector('.markdown')
        || node.querySelector('[data-message-author-role]')
        || node;
      const html = contentNode instanceof HTMLElement ? (contentNode.innerHTML || '') : '';
      const text = normalize(contentNode instanceof HTMLElement ? (contentNode.innerText || contentNode.textContent || '') : '');
      if (!text) continue;
      const key = role + '\\n' + text;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ role, text, html });
    }
    return items;
  })()`);
  const messages = Array.isArray(rows) ? (rows as RawChatGptMessage[]) : [];
  const mapped = mapChatGptMessages(messages, wantMarkdown);
  if (!mapped.length) {
    throw new Error("No visible ChatGPT messages were found.");
  }
  return mapped;
}

cli({
  site: "chatgpt",
  name: "history",
  description: "List visible ChatGPT web conversation history from the sidebar",
  domain: "chatgpt.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "limit", type: "int", default: 20 }],
  columns: ["Index", "Id", "Title", "Url"],
  func: async (page, kwargs) => {
    const limit = intArg(kwargs.limit, 20, 100);
    return getConversationHistory(page as ChatGptBrowserPage, limit);
  },
});

cli({
  site: "chatgpt",
  name: "detail",
  description: "Open a ChatGPT web conversation by ID and read its messages",
  domain: "chatgpt.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "id",
      type: "str",
      required: true,
      positional: true,
      description: "Conversation ID or full /c/<id> URL",
    },
    {
      name: "markdown",
      type: "bool",
      default: false,
      description: "Emit assistant replies as markdown",
    },
  ],
  columns: ["Index", "Role", "Text"],
  func: async (page, kwargs) => {
    const p = page as ChatGptBrowserPage;
    const id = parseChatGptConversationId(kwargs.id);
    const wantMarkdown = normalizeChatGptBoolean(kwargs.markdown, false);
    await p.goto(`${CHATGPT_HOME}/c/${id}`, { settleMs: 2000 });
    try {
      await p.wait({ selector: CONVERSATION_MESSAGE_SELECTOR, timeout: 10 });
    } catch {
      await p.wait(0.5);
    }
    return readVisibleMessages(p, wantMarkdown);
  },
});
