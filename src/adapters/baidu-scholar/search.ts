/**
 * @owner       src::adapters::baidu-scholar::search
 * @does        Registers Baidu Scholar public browser search as a discovery-only scholarly source.
 * @needs       xueshu.baidu.com current `/ndscholar/browse/search` result DOM, src/registry.ts, src/types.ts, browser tools
 * @feeds       src/commands/scholar.ts capability discovery, `unicli baidu-scholar search`, `unicli scholar coverage/doctor`
 * @breaks      Baidu Scholar route or result-card DOM drift can return empty rows or navigation errors.
 * @invariants  Search is discovery-only; source/provider links are hints, not PDF/full-text proof.
 * @side-effects Navigates a Uni-CLI managed browser page to Baidu Scholar public search.
 * @perf        O(limit) DOM extraction after one page navigation.
 * @concurrency safe — command state is page-local
 * @test        live smoke via `unicli baidu-scholar search <query>`; URL contract in tests/unit/adapters/scholar-sources.test.ts
 * @stability   experimental
 * @since       2026-06-27
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { intArg, js, str } from "../_shared/browser-tools.js";

export function buildBaiduScholarSearchUrl(query: string): string {
  return `https://xueshu.baidu.com/ndscholar/browse/search?wd=${encodeURIComponent(query)}`;
}

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
  columns: [
    "id",
    "title",
    "authors",
    "source",
    "year",
    "cited_by_count",
    "source_url",
  ],
  capabilities: [
    "mcp-browser.navigate",
    "mcp-browser.evaluate",
    "scholar.search",
  ],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const limit = intArg(kwargs.limit, 10, 50);
    await p.goto(buildBaiduScholarSearchUrl(str(kwargs.query)), {
      settleMs: 3000,
    });
    const rows = await p.evaluate(`(() => {
      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const cleanAuthor = (value) => normalize(value).replace(/[，,]+$/g, '');
      const paperId = (url) => {
        try {
          return new URL(url, location.href).searchParams.get('paperid') || '';
        } catch {
          return '';
        }
      };
      const cards = [...document.querySelectorAll('.paper-wrap.result, .result, .sc_content, .result-item')];
      return cards.map((card) => {
        const link = card.querySelector('.paper-title a[href], h3 a[href], .t a[href], a[href]');
        const url = link ? new URL(link.getAttribute('href') || '', location.href).href : '';
        const info = card.querySelector('.paper-info');
        const infoText = normalize(info?.textContent);
        const authors = [...(info?.querySelectorAll('a[href*="author"]') || [])]
          .map((node) => cleanAuthor(node.textContent))
          .filter(Boolean);
        const source = normalize(
          [...(info?.querySelectorAll('a[href]') || [])]
            .find((node) => {
              const href = node.getAttribute('href') || '';
              return !href.includes('author%3A') && !href.includes('refpaperuri');
            })?.textContent
        ).replace(/^《|》$/g, '');
        const sourceLinks = [...card.querySelectorAll('.paper-source a[href]')]
          .map((node) => ({
            label: normalize(node.textContent),
            url: new URL(node.getAttribute('href') || '', location.href).href
          }))
          .filter((item) => item.label && item.url && !item.url.startsWith('javascript:'));
        const citedText = normalize(card.querySelector('.paper-info a[href*="refpaperuri"]')?.textContent);
        return {
          id: paperId(url) || url || normalize(link?.textContent),
          title: normalize(link?.textContent),
          authors: authors.join(', '),
          source,
          venue: source,
          type: normalize(card.querySelector('.paper-type')?.textContent),
          year: (infoText.match(/(19|20)\\d{2}/) || [])[0] || '',
          abstract: normalize(card.querySelector('.paper-abstract')?.textContent).replace(/\\s*查看全部>>$/, ''),
          cited_by_count: citedText.match(/\\d+/)?.[0] || '',
          source_url: url,
          url,
          source_links: sourceLinks
        };
      }).filter((row) => row.title).slice(0, ${js(limit)});
    })()`);
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  },
});
