import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { intArg, js, str } from "../_shared/browser-tools.js";

cli({
  site: "powerchina",
  name: "search",
  description: "Search PowerChina procurement notices",
  domain: "bid.powerchina.cn",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["title", "publish_time", "content_type", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const limit = intArg(kwargs.limit, 20, 50);
    await p.goto(
      `https://bid.powerchina.cn/search?keywords=${encodeURIComponent(str(kwargs.query))}`,
      { settleMs: 2500 },
    );
    const rows = await p.evaluate(`(() => {
      const links = [...document.querySelectorAll('a[href]')];
      const seen = new Set();
      return links.map((a) => {
        const parent = a.closest('li, tr, .item, .list-item, div') || a;
        const text = (parent.textContent || '').replace(/\\s+/g, ' ').trim();
        const title = (a.textContent || '').replace(/\\s+/g, ' ').trim();
        const url = new URL(a.getAttribute('href') || '', location.href).href;
        if (!title || seen.has(url)) return null;
        seen.add(url);
        return {
          title,
          url,
          publish_time: (text.match(/\\d{4}[-年.]\\d{1,2}[-月.]\\d{1,2}/) || [''])[0],
          content_type: (text.match(/招标|采购|中标|公告|公示/) || [''])[0],
          snippet: text.slice(0, 280)
        };
      }).filter((row) => row && row.title.length > 4).slice(0, ${js(limit)});
    })()`);
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  },
});
