import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { intArg, js, str } from "../_shared/browser-tools.js";

function policyRowsScript(limit: number): string {
  return `(() => {
    const links = [...document.querySelectorAll('a[href]')];
    const seen = new Set();
    return links.map((a) => {
      const title = (a.textContent || '').replace(/\\s+/g, ' ').trim();
      const href = a.getAttribute('href') || '';
      const url = href ? new URL(href, location.href).href : '';
      if (!title || title.length < 4 || seen.has(url)) return null;
      seen.add(url);
      const parent = a.closest('li, .item, .list, div') || a;
      const text = (parent.textContent || '').replace(/\\s+/g, ' ').trim();
      const date = (text.match(/\\d{4}[-年.]\\d{1,2}[-月.]\\d{1,2}/) || [''])[0];
      return { title, date, url, snippet: text.slice(0, 240) };
    }).filter(Boolean).slice(0, ${js(limit)});
  })()`;
}

cli({
  site: "gov-policy",
  name: "search",
  description: "Search gov.cn policy documents",
  domain: "www.gov.cn",
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
    const url = `https://sousuo.www.gov.cn/zcwjk/policyDocumentLibrary?q=${encodeURIComponent(str(kwargs.query))}&t=zhengcelibrary`;
    await p.goto(url, { settleMs: 2500 });
    const rows = await p.evaluate(policyRowsScript(limit));
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  },
});

cli({
  site: "gov-policy",
  name: "recent",
  description: "List latest State Council policy documents",
  domain: "www.gov.cn",
  strategy: Strategy.PUBLIC,
  browser: true,
  args: [{ name: "limit", type: "int", default: 20 }],
  columns: ["title", "date", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const limit = intArg(kwargs.limit, 20, 100);
    await p.goto("https://www.gov.cn/zhengce/zuixin/", { settleMs: 2500 });
    const rows = await p.evaluate(policyRowsScript(limit));
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  },
});
