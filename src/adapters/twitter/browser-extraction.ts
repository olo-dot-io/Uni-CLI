/**
 * @owner   Twitter browser semantic extraction.
 * @does    Reads X/Twitter search and trend results from the logged-in web UI.
 * @needs   A user-owned Chrome session reachable by Uni-CLI's browser layer.
 * @feeds   twitter.search and twitter.trending.
 * @breaks  X/Twitter DOM changes can reduce parseable rows.
 */

import type { IPage } from "../../types.js";
import { js } from "../_shared/browser-tools.js";
import { socialEmptyError } from "../../social/browser-errors.js";
import { assertTwitterReadable, gotoTwitterPage } from "./browser-state.js";

export interface TwitterTweetRow {
  id: string;
  author: string;
  text: string;
  created_at: string;
  likes: number;
  retweets: number;
  views: number;
  url: string;
}

export const TWEET_COLUMNS = [
  "id",
  "author",
  "text",
  "created_at",
  "likes",
  "retweets",
  "views",
  "url",
];

/** Counts come from aria-labels, which carry exact integers in every UI locale ("4.5万" and "45K" do not). */
export function buildTwitterTweetExtractionScript(limit: number): string {
  return `(() => {
    const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const count = (el) => Number(((el?.getAttribute?.('aria-label') || '').match(/\\d[\\d,.\\s]*/) || ['0'])[0].replace(/\\D/g, '') || 0);
    const rows = [];
    const seen = new Set();
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      const link = article.querySelector('a[href*="/status/"]');
      const href = link?.getAttribute('href') || '';
      const iStatusMatch = href.match(/^\\/i\\/status\\/(\\d+)/);
      const userStatusMatch = href.match(/^\\/(?!i\\/status\\/)([^/?#]+)\\/status\\/(\\d+)/);
      const id = iStatusMatch?.[1] || userStatusMatch?.[2] || '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const fallbackAuthor = clean(article.querySelector('[data-testid="User-Name"]')?.textContent || '').split('@').pop() || 'unknown';
      const author = userStatusMatch ? decodeURIComponent(userStatusMatch[1]) : fallbackAuthor;
      const text = Array.from(article.querySelectorAll('[data-testid="tweetText"]'))
        .map((el) => clean(el.textContent || ''))
        .filter(Boolean)
        .join('\\n');
      if (!text) continue;
      rows.push({
        id,
        author,
        text,
        created_at: article.querySelector('time')?.getAttribute?.('datetime') || '',
        likes: count(article.querySelector('[data-testid="like"],[data-testid="unlike"]')),
        retweets: count(article.querySelector('[data-testid="retweet"],[data-testid="unretweet"]')),
        views: count(article.querySelector('a[href$="/analytics"]')),
        url: 'https://x.com' + href.split('?')[0],
      });
      if (rows.length >= ${js(limit)}) break;
    }
    return rows;
  })()`;
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

  const raw = await page.evaluate(buildTwitterTweetExtractionScript(limit));

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
