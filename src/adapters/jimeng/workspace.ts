import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { clickFirst, intArg, js } from "../_shared/browser-tools.js";

const JIMENG =
  "https://jimeng.jianying.com/ai-tool/generate?type=image&workspace=0";

cli({
  site: "jimeng",
  name: "new",
  description: "Open a new Jimeng generation workspace",
  domain: "jimeng.jianying.com",
  strategy: Strategy.COOKIE,
  browser: true,
  columns: ["ok", "url"],
  func: async (page) => {
    const p = page as IPage;
    await p.goto(JIMENG, { settleMs: 2500 });
    const selector = await clickFirst(p, [
      "button[aria-label*='新建']",
      "button[title*='新建']",
      ".lv-btn-primary",
    ]);
    return [{ ok: true, selector, url: await p.url() }];
  },
});

cli({
  site: "jimeng",
  name: "workspaces",
  description: "List Jimeng visible workspaces",
  domain: "jimeng.jianying.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "limit", type: "int", default: 20 }],
  columns: ["name", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const limit = intArg(kwargs.limit, 20, 100);
    await p.goto(JIMENG, { settleMs: 2500 });
    const rows = await p.evaluate(`(() => {
      const links = [...document.querySelectorAll('a[href*="workspace"], [class*="workspace"] a[href]')];
      const seen = new Set();
      return links.map((a) => {
        const url = new URL(a.getAttribute('href') || '', location.href).href;
        if (seen.has(url)) return null;
        seen.add(url);
        return { name: (a.textContent || '').replace(/\\s+/g, ' ').trim(), url };
      }).filter((row) => row && row.name).slice(0, ${js(limit)});
    })()`);
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  },
});
