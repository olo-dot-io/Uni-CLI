/**
 * @owner       src::adapters::wanfang::search
 * @does        Registers the Wanfang browser search adapter as a discovery-only scholarly source with normalized paper rows.
 * @needs       src/registry.ts, src/types.ts, src/adapters/_shared/browser-tools.ts, Wanfang public search pages
 * @feeds       src/commands/scholar.ts capability discovery, `unicli wanfang search`, `unicli scholar coverage/doctor`
 * @breaks      Upstream DOM changes can return empty search rows; missing id/source_url prevents scholar-layer normalization.
 * @invariants  Search is discovery-only and never claims metadata-get, PDF, full-text, citation, review, code, or dataset evidence.
 * @side-effects Navigates a Uni-CLI managed browser page to Wanfang public search.
 * @perf        O(limit) DOM extraction after one page navigation.
 * @concurrency safe — command state is page-local
 * @test        tests/unit/commands/scholar.test.ts
 * @stability   experimental
 * @since       2026-06-27
 */

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
  columns: ["id", "title", "authors", "source", "year", "source_url"],
  capabilities: [
    "cdp-browser.navigate",
    "cdp-browser.evaluate",
    "scholar.search",
  ],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const limit = intArg(kwargs.limit, 10, 50);
    await p.goto(
      `https://s.wanfangdata.com.cn/paper?q=${encodeURIComponent(str(kwargs.query))}`,
      { settleMs: 2500 },
    );
    const rows = await p.evaluate(`(() => {
      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const detailUrl = (id) => {
        const parts = String(id || '').split('_');
        if (parts.length < 2) return '';
        const type = parts[0];
        const key = parts.slice(1).join('_');
        return key ? 'https://d.wanfangdata.com.cn/' + type + '/' + key : '';
      };
      const cards = [...document.querySelectorAll('.normal-list')].filter((card) =>
        card.querySelector('.title-area .title, .title-id-hidden')
      );
      return cards.map((card) => {
        const id = normalize(card.querySelector('.title-id-hidden')?.textContent);
        const title = normalize(card.querySelector('.title-area .title')?.textContent);
        const authorArea = card.querySelector('.author-area');
        const authorTexts = [...(authorArea?.querySelectorAll('.authors') || [])]
          .map((node) => normalize(node.textContent))
          .filter((text) => text && !/(19|20)\\d{2}年/.test(text) && text !== '等');
        const source = normalize(authorArea?.querySelector('.periodical-title')?.textContent).replace(/^《|》$/g, '');
        const type = normalize(authorArea?.querySelector('.essay-type')?.textContent);
        const authorText = normalize(authorArea?.textContent);
        const year = (authorText.match(/(19|20)\\d{2}/) || [])[0] || '';
        const abstract = normalize(card.querySelector('.abstract-area')?.textContent).replace(/^摘要：?/, '');
        const metrics = normalize(card.querySelector('.button-area')?.textContent);
        const cited = (metrics.match(/被引[:：]?\\s*(\\d+)/) || [])[1] || '';
        const url = detailUrl(id);
        return {
          id: url || title,
          title,
          authors: authorTexts.join(', '),
          source,
          venue: source,
          type,
          year,
          abstract,
          cited_by_count: cited,
          source_url: url,
          url
        };
      }).filter((row) => row.title).slice(0, ${js(limit)});
    })()`);
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  },
});
