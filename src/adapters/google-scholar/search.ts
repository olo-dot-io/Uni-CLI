import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { intArg, js, str } from "../_shared/browser-tools.js";

cli({
  site: "google-scholar",
  name: "search",
  description: "Search Google Scholar papers",
  domain: "scholar.google.com",
  strategy: Strategy.PUBLIC,
  browser: true,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 10 },
  ],
  columns: ["rank", "title", "authors", "source", "year", "cited", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const limit = intArg(kwargs.limit, 10, 20);
    await p.goto(
      `https://scholar.google.com/scholar?q=${encodeURIComponent(str(kwargs.query))}&hl=en`,
      { settleMs: 2500 },
    );
    const rows = await p.evaluate(`(() => {
      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const rows = [];
      const seen = new Set();
      const cards = [...document.querySelectorAll('.gs_r.gs_or.gs_scl, .gs_r.gs_or')];
      for (const card of cards) {
        const body = card.querySelector('.gs_ri') || card;
        const link = body.querySelector('.gs_rt a, h3 a');
        const title = normalize(body.querySelector('.gs_rt, h3')?.textContent);
        if (!title) continue;
        const url = link ? new URL(link.getAttribute('href') || '', location.href).href : '';
        const dedupeKey = url || title.toLowerCase();
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const infoLine = normalize(body.querySelector('.gs_a')?.textContent);
        const parts = infoLine.split(' - ');
        const sourceParts = (parts[1] || '').split(',');
        const citedText = normalize(body.querySelector('.gs_fl a[href*="cites"]')?.textContent);
        rows.push({
          rank: rows.length + 1,
          title,
          authors: (parts[0] || '').trim(),
          source: sourceParts.slice(0, -1).join(',').trim() || sourceParts[0]?.trim() || '',
          year: infoLine.match(/(19|20)\\d{2}/)?.[0] || '',
          cited: citedText.match(/(\\d+)/)?.[1] || '0',
          url,
        });
        if (rows.length >= ${js(limit)}) break;
      }
      return rows;
    })()`);
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  },
});
