import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { intArg, js, str } from "../_shared/browser-tools.js";

function lawRowsScript(limit: number): string {
  return `(() => {
    const cards = [...document.querySelectorAll('a[href], .el-card, .list-item, li')];
    const seen = new Set();
    return cards.map((card) => {
      const link = card.matches?.('a[href]') ? card : card.querySelector?.('a[href]');
      const text = (card.textContent || '').replace(/\\s+/g, ' ').trim();
      const title = (link?.textContent || text).replace(/\\s+/g, ' ').trim();
      const href = link?.getAttribute('href') || '';
      const url = href ? new URL(href, location.href).href : '';
      if (!title || (url && seen.has(url))) return null;
      if (url) seen.add(url);
      const date = (text.match(/\\d{4}[-年.]\\d{1,2}[-月.]\\d{1,2}/) || [''])[0];
      return { title, date, url, snippet: text.slice(0, 240) };
    }).filter((row) => row && row.title.length > 4).slice(0, ${js(limit)});
  })()`;
}

cli({
  site: "gov-law",
  name: "search",
  description: "Search the National Laws and Regulations Database",
  domain: "flk.npc.gov.cn",
  strategy: Strategy.PUBLIC,
  browser: true,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["title", "date", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const limit = intArg(kwargs.limit, 20, 100);
    const url = `https://flk.npc.gov.cn/search.html?keyword=${encodeURIComponent(str(kwargs.query))}`;
    await p.goto(url, { settleMs: 2500 });
    const rows = await p.evaluate(lawRowsScript(limit));
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  },
});

cli({
  site: "gov-law",
  name: "recent",
  description: "List recent laws and regulations",
  domain: "flk.npc.gov.cn",
  strategy: Strategy.PUBLIC,
  browser: true,
  args: [{ name: "limit", type: "int", default: 20 }],
  columns: ["title", "date", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const limit = intArg(kwargs.limit, 20, 100);
    await p.goto("https://flk.npc.gov.cn/", { settleMs: 2500 });
    const rows = await p.evaluate(lawRowsScript(limit));
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  },
});
