import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { intArg, js, str, visibleText } from "../_shared/browser-tools.js";

const APP = "https://mubu.com/app";

async function readDocList(
  page: IPage,
  url: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  await page.goto(url, { settleMs: 2500 });
  const rows = (await page.evaluate(`(() => {
    const cards = [...document.querySelectorAll('a[href*="/doc/"], [class*="doc-item"], [class*="document-item"], [class*="file-item"]')];
    const seen = new Set();
    return cards.map((card) => {
      const link = card.matches?.('a') ? card : card.querySelector?.('a[href*="/doc/"]');
      const url = link ? new URL(link.getAttribute('href') || '', location.href).href : '';
      if (url && seen.has(url)) return null;
      if (url) seen.add(url);
      return {
        title: (card.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
        url,
        updated: (card.querySelector?.('[class*="time"], [class*="date"], [class*="update"]')?.textContent || '').trim()
      };
    }).filter((row) => row && row.title).slice(0, ${js(limit)});
  })()`)) as Record<string, unknown>[];
  return rows;
}

cli({
  site: "mubu",
  name: "docs",
  description: "List Mubu documents and folders",
  domain: "mubu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "folder", type: "str", required: false },
    { name: "starred", type: "bool", default: false },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["title", "updated", "url"],
  func: async (page, kwargs) => {
    const folder = str(kwargs.folder);
    const url = folder ? `${APP}/folder/${encodeURIComponent(folder)}` : APP;
    return readDocList(page as IPage, url, intArg(kwargs.limit, 20, 100));
  },
});

cli({
  site: "mubu",
  name: "doc",
  description: "Read a Mubu document as Markdown-like text",
  domain: "mubu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "id", type: "str", required: true, positional: true },
    { name: "output", type: "str", default: "markdown" },
  ],
  columns: ["title", "content", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const id = str(kwargs.id);
    const url = id.startsWith("http") ? id : `https://mubu.com/doc/${id}`;
    await p.goto(url, { settleMs: 2500 });
    const content = await visibleText(p);
    return [{ title: await p.title(), content, url: await p.url() }];
  },
});

cli({
  site: "mubu",
  name: "recent",
  description: "List recently edited Mubu documents",
  domain: "mubu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "limit", type: "int", default: 20 }],
  columns: ["title", "updated", "url"],
  func: async (page, kwargs) =>
    readDocList(page as IPage, `${APP}/recent`, intArg(kwargs.limit, 20, 100)),
});

cli({
  site: "mubu",
  name: "notes",
  description: "Read Mubu quick notes for a date or date range",
  domain: "mubu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "date", type: "str", required: false },
    { name: "month", type: "str", required: false },
    { name: "from", type: "str", required: false },
    { name: "to", type: "str", required: false },
    { name: "list", type: "bool", default: false },
  ],
  columns: ["title", "content", "url"],
  func: async (page) => {
    const p = page as IPage;
    await p.goto(`${APP}/notes`, { settleMs: 2500 });
    const content = await visibleText(p);
    return [{ title: await p.title(), content, url: await p.url() }];
  },
});
