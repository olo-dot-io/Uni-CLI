import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import {
  boolArg,
  clickFirst,
  intArg,
  js,
  str,
  visibleText,
} from "../_shared/browser-tools.js";

const HOME = "https://chat.deepseek.com";
const CHAT = `${HOME}/`;
const INPUT = "textarea, [contenteditable='true'], .chat-input textarea";
const FILE_INPUT = 'input[type="file"]';
const MESSAGES =
  "[class*='message'], [data-role='message'], .markdown-body, main article";
const ATTACH_SELECTORS = [
  'button[aria-label*="Attach"]',
  'button[aria-label*="Upload"]',
  'button[aria-label*="上传"]',
  'button[aria-label*="附件"]',
  'label[for*="file"]',
  'button:has-text("上传")',
  'button:has-text("附件")',
  'button:has-text("Attach")',
];

async function openChat(page: IPage): Promise<void> {
  await page.goto(CHAT, { settleMs: 1800 });
}

async function readConversation(
  page: IPage,
): Promise<Record<string, unknown>[]> {
  await openChat(page);
  const items = (await page.evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${js(MESSAGES)})];
    const rows = nodes.map((node, index) => ({
      index: index + 1,
      text: (node.textContent || '').trim(),
      role: /user|human|question/i.test(node.getAttribute('class') || '') ? 'user' : 'assistant'
    })).filter((row) => row.text.length > 0);
    return rows.length ? rows : [{ index: 1, role: 'page', text: (document.body?.innerText || '').trim().slice(0, 4000) }];
  })()`)) as Record<string, unknown>[];
  return items;
}

function resolveUploadFiles(value: unknown): string[] {
  const raw = str(value).trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((file) => resolve(file.trim()))
    .filter(Boolean)
    .map((file) => {
      if (!existsSync(file))
        throw new Error(`DeepSeek upload file not found: ${file}`);
      return file;
    });
}

async function attachFiles(page: IPage, files: string[]): Promise<void> {
  if (files.length === 0) return;
  await clickFirst(page, ATTACH_SELECTORS);
  await page.setFileInput(FILE_INPUT, files);
  await page.wait(2);
}

cli({
  site: "deepseek",
  name: "ask",
  description: "Send a prompt to DeepSeek web chat and wait for a response",
  domain: "chat.deepseek.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "prompt", type: "str", required: true, positional: true },
    { name: "timeout", type: "int", default: 120 },
    { name: "new", type: "bool", default: false },
    { name: "model", type: "str", default: "instant" },
    { name: "think", type: "bool", default: false },
    { name: "search", type: "bool", default: false },
    {
      name: "file",
      type: "str",
      required: false,
      description: "Local file path, or comma-separated paths, to upload first",
    },
  ],
  columns: ["response"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    await openChat(p);
    if (boolArg(kwargs.new)) {
      await clickFirst(p, [
        "a[href='/']",
        "button[aria-label*='New']",
        "button[aria-label*='新']",
        "button:has-text('新对话')",
      ]);
      await p.wait(0.8);
    }
    await attachFiles(p, resolveUploadFiles(kwargs.file));
    await p.click(INPUT);
    await p.insertText(str(kwargs.prompt));
    await p.press("Enter");
    const timeout = intArg(kwargs.timeout, 120, 600);
    let previous = "";
    let stable = 0;
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      await p.wait(1);
      const rows = await readConversation(p);
      const text = str(rows.at(-1)?.text);
      if (text && text === previous) stable += 1;
      else stable = 0;
      previous = text;
      if (stable >= 2) return [{ response: text }];
    }
    return [{ response: previous }];
  },
});

cli({
  site: "deepseek",
  name: "new",
  description: "Start a new DeepSeek web conversation",
  domain: "chat.deepseek.com",
  strategy: Strategy.COOKIE,
  browser: true,
  func: async (page) => {
    const p = page as IPage;
    await openChat(p);
    const selector = await clickFirst(p, [
      "a[href='/']",
      "button[aria-label*='New']",
      "button[aria-label*='新']",
      "button:has-text('新对话')",
    ]);
    return [{ ok: selector !== null, selector }];
  },
});

cli({
  site: "deepseek",
  name: "status",
  description: "Check DeepSeek web page availability and login state",
  domain: "chat.deepseek.com",
  strategy: Strategy.COOKIE,
  browser: true,
  columns: ["title", "url", "logged_in"],
  func: async (page) => {
    const p = page as IPage;
    await openChat(p);
    const text = await visibleText(p);
    return [
      {
        title: await p.title(),
        url: await p.url(),
        logged_in: !/登录|sign in|login/i.test(text),
      },
    ];
  },
});

cli({
  site: "deepseek",
  name: "read",
  description: "Read the visible DeepSeek web conversation",
  domain: "chat.deepseek.com",
  strategy: Strategy.COOKIE,
  browser: true,
  columns: ["index", "role", "text"],
  func: async (page) => readConversation(page as IPage),
});

cli({
  site: "deepseek",
  name: "history",
  description: "List DeepSeek conversation history from the sidebar",
  domain: "chat.deepseek.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "limit", type: "int", default: 20 }],
  columns: ["title", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    await openChat(p);
    const limit = intArg(kwargs.limit, 20, 100);
    const rows = (await p.evaluate(`(() => {
      const links = [...document.querySelectorAll('a[href*="/chat/"], a[href*="conversation"]')];
      return links.map((a) => ({
        title: (a.textContent || '').trim(),
        url: new URL(a.getAttribute('href') || '', location.href).href
      })).filter((row) => row.title);
    })()`)) as Record<string, unknown>[];
    return rows.slice(0, limit);
  },
});
