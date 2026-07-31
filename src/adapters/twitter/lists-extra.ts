/**
 * @owner   src/adapters/twitter/lists-extra.ts
 * @does    Register browser-backed Twitter/X user timeline and list membership commands.
 * @needs   User-owned browser session on x.com, Twitter page readability checks, shared browser DOM extraction helpers.
 * @feeds   twitter.tweets, twitter.user-tweets, twitter.user-timeline, twitter.list-tweets, twitter.list-add, twitter.list-remove.
 * @breaks  X/Twitter DOM or URL-shape drift can make timeline rows empty or misidentify tweet authors.
 * @invariants User timeline commands normalize @handles and emit the standard tweet row shape.
 * @side-effects Navigates the browser to X/Twitter profile, list, and list-management pages.
 * @perf     Scrolls at most two viewport batches for read commands.
 * @concurrency Browser session state is shared by the command runtime.
 * @test     src/adapters/twitter/lists-extra.test.ts
 * @stability stable
 * @since    2026-05-27
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { clickFirst, intArg, js, str } from "../_shared/browser-tools.js";
import { socialEmptyError } from "../../social/browser-errors.js";
import { assertTwitterReadable, gotoTwitterPage } from "./browser-state.js";

const TWEET_COLUMNS = [
  "id",
  "author",
  "text",
  "likes",
  "retweets",
  "views",
  "url",
];

function normalizeTwitterPageUrl(url: string): string {
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/");
  if (parts[1]?.startsWith("@")) {
    parts[1] = parts[1].slice(1);
    parsed.pathname = parts.join("/");
  }
  return parsed.toString().replace(/\/$/, "");
}

function twitterUserTimelineUrl(user: string): string {
  return `https://x.com/${encodeURIComponent(user.replace(/^@/, ""))}`;
}

export function buildTwitterTweetExtractionScript(limit: number): string {
  return `(() => {
    const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim();
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
      const metric = (name) => clean(article.querySelector('[data-testid="' + name + '"]')?.textContent || '');
      if (!text) continue;
      rows.push({
        id,
        author,
        text,
        likes: metric('like'),
        retweets: metric('retweet'),
        views: clean(article.querySelector('a[href$="/analytics"]')?.textContent || ''),
        url: 'https://x.com' + href.split('?')[0],
      });
      if (rows.length >= ${js(limit)}) break;
    }
    return rows;
  })()`;
}

export async function extractTweets(
  page: IPage,
  url: string,
  limit: number,
  command: string,
): Promise<Record<string, unknown>[]> {
  await gotoTwitterPage(page, normalizeTwitterPageUrl(url), command);
  await page.autoScroll({ maxScrolls: 2, delay: 1000 });
  await assertTwitterReadable(page, command);
  const rows = await page.evaluate(buildTwitterTweetExtractionScript(limit));
  const parsedRows = Array.isArray(rows)
    ? (rows as Record<string, unknown>[])
    : [];
  if (parsedRows.length > 0) return parsedRows;
  throw socialEmptyError(
    "twitter",
    command,
    `Twitter/X ${command} loaded no parseable tweets from ${url}.`,
  );
}

function userTimelineFunc(command: string) {
  return async (page: unknown, kwargs: Record<string, unknown>) =>
    extractTweets(
      page as IPage,
      twitterUserTimelineUrl(str(kwargs.user)),
      intArg(kwargs.limit, 20, 100),
      command,
    );
}

cli({
  site: "twitter",
  name: "tweets",
  description: "Read recent tweets from a Twitter/X user profile",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "user", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: TWEET_COLUMNS,
  socialCapabilities: ["read", "author", "user_content"],
  func: userTimelineFunc("tweets"),
});

cli({
  site: "twitter",
  name: "user-tweets",
  description: "Read recent tweets from a Twitter/X user profile",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "user", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: TWEET_COLUMNS,
  socialCapabilities: ["read", "author", "user_content"],
  func: userTimelineFunc("user-tweets"),
});

cli({
  site: "twitter",
  name: "user-timeline",
  description: "Read a Twitter/X user's tweet timeline",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "user", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: TWEET_COLUMNS,
  socialCapabilities: ["read", "author", "user_content"],
  func: userTimelineFunc("user-timeline"),
});

cli({
  site: "twitter",
  name: "list-tweets",
  description: "Read tweets from a Twitter/X list timeline",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "list", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: TWEET_COLUMNS,
  socialCapabilities: ["read", "lists", "user_content"],
  func: async (page, kwargs) => {
    const list = str(kwargs.list);
    const url = list.startsWith("http")
      ? list
      : `https://x.com/i/lists/${encodeURIComponent(list)}`;
    return extractTweets(
      page as IPage,
      url,
      intArg(kwargs.limit, 20, 100),
      "list-tweets",
    );
  },
});

cli({
  site: "twitter",
  name: "list-add",
  description: "Add a Twitter/X user to a list from the browser UI",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  browser: true,
  operation_family: "update",
  args: [
    { name: "list", type: "str", required: true, positional: true },
    { name: "user", type: "str", required: true },
  ],
  columns: ["ok", "selector", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const list = str(kwargs.list);
    const user = str(kwargs.user).replace(/^@/, "");
    const url = list.startsWith("http")
      ? `${list}/members/suggested`
      : `https://x.com/i/lists/${encodeURIComponent(list)}/members/suggested`;
    await p.goto(url, { settleMs: 2500 });
    await p.evaluate(`(() => {
      const input = document.querySelector('input[aria-label*="Search"], input[placeholder*="Search"], input[placeholder*="搜索"]');
      if (input) {
        input.value = ${js(user)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()`);
    await p.wait(1);
    const selector = await clickFirst(p, [
      "[data-testid='UserCell'] button",
      "button[aria-label*='Add']",
      "button[aria-label*='添加']",
    ]);
    return [{ ok: selector !== null, selector, url: await p.url() }];
  },
});

cli({
  site: "twitter",
  name: "list-remove",
  description: "Remove a Twitter/X user from a list from the browser UI",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  browser: true,
  operation_family: "update",
  args: [
    { name: "list", type: "str", required: true, positional: true },
    { name: "user", type: "str", required: true },
  ],
  columns: ["ok", "selector", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const list = str(kwargs.list);
    const user = str(kwargs.user).replace(/^@/, "");
    const url = list.startsWith("http")
      ? `${list}/members`
      : `https://x.com/i/lists/${encodeURIComponent(list)}/members`;
    await p.goto(url, { settleMs: 2500 });
    await p.evaluate(`(() => {
      const cells = [...document.querySelectorAll('[data-testid="UserCell"]')];
      const cell = cells.find((node) => (node.textContent || '').includes(${js(user)}));
      const button = cell?.querySelector('button');
      if (button) button.click();
    })()`);
    await p.wait(0.8);
    const selector = await clickFirst(p, [
      "button[role='button'][data-testid='confirmationSheetConfirm']",
      "button[aria-label*='Remove']",
      "button[aria-label*='移除']",
    ]);
    return [{ ok: selector !== null, selector, url: await p.url() }];
  },
});
