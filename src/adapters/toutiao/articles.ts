import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { intArg, js } from "../_shared/browser-tools.js";

cli({
  site: "toutiao",
  name: "articles",
  description: "List Toutiao creator dashboard articles",
  domain: "mp.toutiao.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "page", type: "int", default: 1 },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["title", "date", "status", "reads", "likes", "comments"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const current = intArg(kwargs.page, 1, 100);
    const limit = intArg(kwargs.limit, 20, 100);
    await p.goto(
      `https://mp.toutiao.com/profile_v4/manage/content/all?page=${current}`,
      {
        settleMs: 3500,
      },
    );
    const rows = await p.evaluate(`(() => {
      const cards = [...document.querySelectorAll('tr, [class*="article"], [class*="content-item"], [role="row"]')];
      return cards.map((card) => {
        const text = (card.textContent || '').replace(/\\s+/g, ' ').trim();
        const nums = text.match(/\\d+/g) || [];
        return {
          title: (card.querySelector('[class*="title"], a[href]')?.textContent || '').replace(/\\s+/g, ' ').trim(),
          date: (text.match(/\\d{4}[-年.]\\d{1,2}[-月.]\\d{1,2}/) || [''])[0],
          status: (text.match(/已发布|草稿|审核|未通过|发布中/) || [''])[0],
          impressions: nums[0] || '',
          reads: nums[1] || '',
          likes: nums[2] || '',
          comments: nums[3] || ''
        };
      }).filter((row) => row.title).slice(0, ${js(limit)});
    })()`);
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  },
});
