import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { intArg, js, str } from "../_shared/browser-tools.js";

cli({
  site: "baidu-scholar",
  name: "search",
  description: "Search Baidu Scholar papers",
  domain: "xueshu.baidu.com",
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
      `https://xueshu.baidu.com/s?wd=${encodeURIComponent(str(kwargs.query))}`,
      { settleMs: 2500 },
    );
    const rows = await p.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.result, .sc_content, .result-item')];
      return cards.map((card) => {
        const link = card.querySelector('h3 a, .t a, a[href]');
        return {
          title: (link?.textContent || '').replace(/\\s+/g, ' ').trim(),
          authors: (card.querySelector('.author_text, .sc_info, .c_font')?.textContent || '').replace(/\\s+/g, ' ').trim(),
          source: (card.querySelector('.journal_title, .sc_info')?.textContent || '').replace(/\\s+/g, ' ').trim(),
          url: link ? new URL(link.getAttribute('href') || '', location.href).href : ''
        };
      }).filter((row) => row.title).slice(0, ${js(limit)});
    })()`);
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  },
});
