import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { intArg, js, str } from "../_shared/browser-tools.js";

cli({
  site: "maimai",
  name: "search-talents",
  description: "Search Maimai talent profiles with filters",
  domain: "maimai.cn",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "companies", type: "str", required: false },
    { name: "schools", type: "str", required: false },
    { name: "cities", type: "str", required: false },
    { name: "page", type: "int", default: 0 },
    { name: "size", type: "int", default: 20 },
  ],
  columns: ["name", "title", "company", "location"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const size = intArg(kwargs.size, 20, 100);
    const query = str(kwargs.query);
    await p.goto("https://maimai.cn/ent/talents/discover/search_v2", {
      settleMs: 3000,
    });
    const rows = await p.evaluate(`(async () => {
      const response = await fetch('/ent/talents/discover/search_v2', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          keywords: ${js(query)},
          page: ${Number(kwargs.page ?? 0)},
          size: ${size},
          companies: ${js(str(kwargs.companies))},
          schools: ${js(str(kwargs.schools))},
          cities: ${js(str(kwargs.cities))}
        })
      }).catch(() => null);
      if (response?.ok) {
        const json = await response.json();
        const list = json?.data?.list || json?.data?.items || [];
        if (Array.isArray(list) && list.length) {
          return list.map((item) => ({
            name: item.name || item.real_name || '',
            title: item.position || item.title || '',
            company: item.company || item.company_name || '',
            location: item.city || item.location || '',
            raw: item
          }));
        }
      }
      const cards = [...document.querySelectorAll('[class*="talent"], [class*="card"], [role="listitem"]')];
      return cards.map((card) => ({
        name: (card.querySelector('[class*="name"]')?.textContent || '').trim(),
        title: (card.querySelector('[class*="position"], [class*="title"]')?.textContent || '').trim(),
        company: (card.querySelector('[class*="company"]')?.textContent || '').trim(),
        location: (card.querySelector('[class*="city"], [class*="location"]')?.textContent || '').trim()
      })).filter((row) => row.name || row.title).slice(0, ${size});
    })()`);
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  },
});
