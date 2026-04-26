import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { intArg, js } from "../_shared/browser-tools.js";

cli({
  site: "ths",
  name: "hot-rank",
  description: "Read Tonghuashun hot-stock ranking",
  domain: "eq.10jqka.com.cn",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "limit", type: "int", default: 20 }],
  columns: ["rank", "name", "changePercent", "heat"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const limit = intArg(kwargs.limit, 20, 100);
    await p.goto("https://eq.10jqka.com.cn/", { settleMs: 2500 });
    const rows = await p.evaluate(`(() => {
      const cards = [...document.querySelectorAll('tr, [role="row"], .rank-item, .stock-item, li')];
      return cards.map((card, index) => {
        const text = (card.textContent || '').replace(/\\s+/g, ' ').trim();
        const symbol = (text.match(/\\b\\d{6}\\b/) || [''])[0];
        return {
          rank: index + 1,
          symbol,
          name: text.replace(symbol, '').slice(0, 50),
          changePercent: (text.match(/[+-]?\\d+(?:\\.\\d+)?%/) || [''])[0],
          heat: (text.match(/\\d+(?:\\.\\d+)?[万亿]?/) || [''])[0],
          tags: text
        };
      }).filter((row) => row.symbol || row.name).slice(0, ${js(limit)});
    })()`);
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  },
});
