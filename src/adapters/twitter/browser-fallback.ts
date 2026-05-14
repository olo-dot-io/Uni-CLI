/**
 * @owner   Twitter browser fallback extraction.
 * @does    Reads X/Twitter search and trend results from the logged-in web UI.
 * @needs   A user-owned Chrome session reachable by Uni-CLI's browser layer.
 * @feeds   twitter.search and twitter.trending.
 * @breaks  X/Twitter DOM changes can reduce parseable rows.
 */

import type { IPage } from "../../types.js";
import { socialEmptyError } from "../../social/browser-errors.js";
import { assertTwitterReadable, gotoTwitterPage } from "./browser-state.js";

export interface TwitterTweetRow {
  id: string;
  author: string;
  text: string;
  likes: string;
  retweets: string;
  views: string;
  url: string;
}

export interface TwitterTrendRow {
  name: string;
  tweet_count: string;
  description: string;
  url: string;
}

export async function browserSearchTweets(
  page: IPage,
  query: string,
  limit: number,
): Promise<TwitterTweetRow[]> {
  await gotoTwitterPage(
    page,
    `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`,
    "search",
  );
  await page.autoScroll({ maxScrolls: 2, delay: 1000 });
  await assertTwitterReadable(page, "search");

  const raw = await page.evaluate(`
    (() => {
      const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const rows = [];
      const seen = new Set();
      for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
        const status = article.querySelector('a[href*="/status/"]');
        const href = status?.getAttribute('href') || '';
        const id = (href.match(/\\/status\\/(\\d+)/) || [])[1] || '';
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const text = Array.from(article.querySelectorAll('[data-testid="tweetText"]'))
          .map((el) => clean(el.textContent || ''))
          .filter(Boolean)
          .join('\\n');
        if (!text) continue;
        const userName = clean(article.querySelector('[data-testid="User-Name"]')?.textContent || '');
        const author = userName.split('@')[0] || userName;
        const metric = (name) => clean(article.querySelector('[data-testid="' + name + '"]')?.textContent || '');
        rows.push({
          id,
          author,
          text,
          likes: metric('like'),
          retweets: metric('retweet'),
          views: clean(article.querySelector('a[href$="/analytics"]')?.textContent || ''),
          url: 'https://x.com' + href.split('?')[0],
        });
      }
      return rows;
    })()
  `);

  const rows = Array.isArray(raw)
    ? (raw as TwitterTweetRow[]).slice(0, limit)
    : [];
  if (rows.length > 0) return rows;
  throw socialEmptyError(
    "twitter",
    "search",
    `Twitter/X search loaded no parseable tweets for "${query}".`,
  );
}

export async function browserTrendingTopics(
  page: IPage,
  limit: number,
): Promise<TwitterTrendRow[]> {
  await gotoTwitterPage(
    page,
    "https://x.com/explore/tabs/trending",
    "trending",
  );

  const raw = await page.evaluate(`
    (() => {
      const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const rows = [];
      const seen = new Set();
      for (const link of document.querySelectorAll('a[href*="/search?q="]')) {
        const href = link.getAttribute('href') || '';
        let name = '';
        try {
          name = new URL(href, 'https://x.com').searchParams.get('q') || '';
        } catch {}
        const lines = clean(link.textContent || '')
          .split(/(?=Trending|[0-9,.]+\\s+posts)/)
          .map(clean)
          .filter(Boolean);
        if (!name) {
          name = lines.find((line) => !/^Trending/i.test(line) && !/posts$/i.test(line)) || '';
        }
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const meta = lines.find((line) => /posts$/i.test(line)) || '';
        rows.push({
          name,
          tweet_count: meta,
          description: lines.find((line) => /^Trending/i.test(line)) || '',
          url: 'https://x.com' + href,
        });
      }
      return rows;
    })()
  `);

  const rows = Array.isArray(raw)
    ? (raw as TwitterTrendRow[]).slice(0, limit)
    : [];
  if (rows.length > 0) return rows;
  throw socialEmptyError(
    "twitter",
    "trending",
    "Twitter/X explore loaded no parseable trend rows.",
  );
}
