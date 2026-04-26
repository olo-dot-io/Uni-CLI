import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { intArg, js, str } from "../_shared/browser-tools.js";

cli({
  site: "wanfang",
  name: "search",
  description: "Search Wanfang papers by keyword",
  domain: "s.wanfangdata.com.cn",
  strategy: Strategy.PUBLIC,
  browser: true,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 10 },
  ],
  columns: ["title", "authors", "source", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const limit = intArg(kwargs.limit, 10, 50);
    await p.goto(
      `https://s.wanfangdata.com.cn/paper?q=${encodeURIComponent(str(kwargs.query))}`,
      { settleMs: 2500 },
    );
    const rows = await p.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.normal-list .item, .result-list .item, .paper-item, .record-item')];
      return cards.map((card) => {
        const link = card.querySelector('a[href], span.title a');
        return {
          title: (card.querySelector('span.title, .title, a[href]')?.textContent || '').replace(/\\s+/g, ' ').trim(),
          authors: (card.querySelector('span.authors, .authors, .author')?.textContent || '').replace(/\\s+/g, ' ').trim(),
          source: (card.querySelector('.source, .journal, .info')?.textContent || '').replace(/\\s+/g, ' ').trim(),
          url: link ? new URL(link.getAttribute('href') || '', location.href).href : ''
        };
      }).filter((row) => row.title).slice(0, ${js(limit)});
    })()`);
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  },
});
