/**
 * Xiaohongshu search — DOM-based extraction from search results page.
 *
 * Navigates to the search results page and extracts data from rendered
 * DOM elements.  Uses MutationObserver to wait for content or login wall.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";

/**
 * Wait for search results or login wall using MutationObserver (max 5 s).
 */
const WAIT_FOR_CONTENT_JS = `
  new Promise((resolve) => {
    const detect = () => {
      if (document.querySelector('section.note-item')) return 'content';
      if (/登录后查看搜索结果/.test(document.body?.innerText || '')) return 'login_wall';
      return null;
    };
    const found = detect();
    if (found) return resolve(found);
    const observer = new MutationObserver(() => {
      const result = detect();
      if (result) { observer.disconnect(); resolve(result); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); resolve('timeout'); }, 5000);
  })
`;

/**
 * Extract approximate publish date from a Xiaohongshu note URL.
 * XHS note IDs follow MongoDB ObjectID format where the first 8 hex
 * characters encode a Unix timestamp.
 */
export function noteIdToDate(url: string): string {
  const match = url.match(
    /\/(?:search_result|explore|note)\/([0-9a-f]{24})(?=[?#/]|$)/i,
  );
  if (!match) return "";
  const hex = match[1].substring(0, 8);
  const ts = parseInt(hex, 16);
  if (!ts || ts < 1_000_000_000 || ts > 4_000_000_000) return "";
  return new Date((ts + 8 * 3600) * 1000).toISOString().slice(0, 10);
}

cli({
  site: "xiaohongshu",
  name: "search",
  description: "Search notes on Xiaohongshu",
  domain: "www.xiaohongshu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "query",
      required: true,
      positional: true,
      description: "Search keyword",
    },
    { name: "limit", type: "int", default: 20, description: "Number of results" },
  ],
  columns: ["rank", "title", "author", "likes", "published_at", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const keyword = encodeURIComponent(String(kwargs.query));
    await p.goto(
      `https://www.xiaohongshu.com/search_result?keyword=${keyword}&source=web_search_result_notes`,
    );

    const waitResult = await p.evaluate(WAIT_FOR_CONTENT_JS);

    if (waitResult === "login_wall") {
      throw new Error(
        "Xiaohongshu search results are blocked behind a login wall",
      );
    }

    // Scroll a couple of times to load more results
    await p.autoScroll({ maxScrolls: 2, delay: 1500 });

    const payload = await p.evaluate(`
      (() => {
        const normalizeUrl = (href) => {
          if (!href) return '';
          if (href.startsWith('http://') || href.startsWith('https://')) return href;
          if (href.startsWith('/')) return 'https://www.xiaohongshu.com' + href;
          return '';
        };
        const cleanText = (value) => (value || '').replace(/\\s+/g, ' ').trim();
        const results = [];
        const seen = new Set();
        document.querySelectorAll('section.note-item').forEach(el => {
          if (el.classList.contains('query-note-item')) return;
          const titleEl = el.querySelector('.title, .note-title, a.title, .footer .title span');
          const nameEl = el.querySelector('a.author .name, .name, .author-name, .nick-name, a.author');
          const likesEl = el.querySelector('.count, .like-count, .like-wrapper .count');
          const detailLinkEl =
            el.querySelector('a.cover.mask') ||
            el.querySelector('a[href*="/search_result/"]') ||
            el.querySelector('a[href*="/explore/"]') ||
            el.querySelector('a[href*="/note/"]');
          const url = normalizeUrl(detailLinkEl?.getAttribute('href') || '');
          if (!url) return;
          if (seen.has(url)) return;
          seen.add(url);
          results.push({
            title: cleanText(titleEl?.textContent || ''),
            author: cleanText(nameEl?.textContent || ''),
            likes: cleanText(likesEl?.textContent || '0'),
            url,
          });
        });
        return results;
      })()
    `);

    const limit = Number(kwargs.limit) || 20;
    const data: Record<string, unknown>[] = Array.isArray(payload)
      ? (payload as Record<string, unknown>[])
      : [];
    return data
      .filter((item) => item.title)
      .slice(0, limit)
      .map((item, i) => ({
        rank: i + 1,
        ...item,
        published_at: noteIdToDate(String(item.url ?? "")),
      }));
  },
});
