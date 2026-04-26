import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import {
  clickFirst,
  intArg,
  js,
  str,
  visibleText,
} from "../_shared/browser-tools.js";

const CHAT = "https://www.doubao.com/chat";
const INPUT = "textarea, [contenteditable='true'], .chat-input textarea";
const MESSAGE_SELECTOR =
  "[class*='message'], [data-testid*='message'], [class*='markdown'], main article";

async function openDoubao(page: IPage): Promise<void> {
  await page.goto(CHAT, { settleMs: 1800 });
}

async function readMessages(page: IPage): Promise<Record<string, unknown>[]> {
  await openDoubao(page);
  const rows = await page.evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${js(MESSAGE_SELECTOR)})];
    const items = nodes.map((node, index) => ({
      index: index + 1,
      text: (node.textContent || '').trim(),
      role: /user|human|question/i.test(node.getAttribute('class') || '') ? 'user' : 'assistant'
    })).filter((row) => row.text);
    return items.length ? items : [{ index: 1, role: 'page', text: (document.body?.innerText || '').trim().slice(0, 4000) }];
  })()`);
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

cli({
  site: "doubao",
  name: "send",
  description: "Send text to the current Doubao web chat",
  domain: "www.doubao.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "text", type: "str", required: true, positional: true }],
  func: async (page, kwargs) => {
    const p = page as IPage;
    await openDoubao(p);
    await p.click(INPUT);
    await p.insertText(str(kwargs.text));
    await p.press("Enter");
    return [{ ok: true }];
  },
});

cli({
  site: "doubao",
  name: "read",
  description: "Read visible Doubao web conversation messages",
  domain: "www.doubao.com",
  strategy: Strategy.COOKIE,
  browser: true,
  columns: ["index", "role", "text"],
  func: async (page) => readMessages(page as IPage),
});

cli({
  site: "doubao",
  name: "history",
  description: "List Doubao web conversation history",
  domain: "www.doubao.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "limit", type: "int", default: 20 }],
  columns: ["title", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    await openDoubao(p);
    const limit = intArg(kwargs.limit, 20, 100);
    const rows = await p.evaluate(`(() => {
      const links = [...document.querySelectorAll('a[href*="/chat/"], a[href*="conversation"], a[href*="thread"]')];
      return links.map((a) => ({
        title: (a.textContent || '').trim(),
        url: new URL(a.getAttribute('href') || '', location.href).href
      })).filter((row) => row.title);
    })()`);
    return Array.isArray(rows)
      ? (rows as Record<string, unknown>[]).slice(0, limit)
      : [];
  },
});

cli({
  site: "doubao",
  name: "detail",
  description: "Read a Doubao conversation by id or URL",
  domain: "www.doubao.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "id", type: "str", required: true, positional: true }],
  columns: ["index", "role", "text"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const id = str(kwargs.id);
    const url = id.startsWith("http")
      ? id
      : `${CHAT}/${encodeURIComponent(id)}`;
    await p.goto(url, { settleMs: 1800 });
    return readMessages(p);
  },
});

cli({
  site: "doubao",
  name: "meeting-summary",
  description: "Extract the visible summary for a Doubao meeting record",
  domain: "www.doubao.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "id", type: "str", required: true, positional: true }],
  columns: ["id", "summary"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const id = str(kwargs.id);
    const url = id.startsWith("http")
      ? id
      : `${CHAT}/${encodeURIComponent(id)}`;
    await p.goto(url, { settleMs: 1800 });
    const text = await visibleText(p);
    return [{ id, summary: text.slice(0, 4000) }];
  },
});

cli({
  site: "doubao",
  name: "meeting-transcript",
  description: "Extract visible transcript text for a Doubao meeting record",
  domain: "www.doubao.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "id", type: "str", required: true, positional: true }],
  columns: ["id", "transcript"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const id = str(kwargs.id);
    const url = id.startsWith("http")
      ? id
      : `${CHAT}/${encodeURIComponent(id)}`;
    await p.goto(url, { settleMs: 1800 });
    await clickFirst(p, [
      "button[aria-label*='转写']",
      "button[aria-label*='记录']",
      "button[aria-label*='Transcript']",
    ]);
    const text = await visibleText(p);
    return [{ id, transcript: text.slice(0, 8000) }];
  },
});
