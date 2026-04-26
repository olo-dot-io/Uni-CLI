import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { clickFirst, intArg, js, str } from "../_shared/browser-tools.js";

async function extractTweets(
  page: IPage,
  url: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  await page.goto(url, { settleMs: 2500 });
  const rows = await page.evaluate(`(() => {
    const tweets = [...document.querySelectorAll('article[data-testid="tweet"]')];
    return tweets.map((article) => {
      const user = article.querySelector('[data-testid="User-Name"]')?.textContent || '';
      const text = article.querySelector('[data-testid="tweetText"]')?.textContent || '';
      const link = [...article.querySelectorAll('a[href*="/status/"]')].pop();
      return {
        author: user.replace(/\\s+/g, ' ').trim(),
        text: text.replace(/\\s+/g, ' ').trim(),
        url: link ? new URL(link.getAttribute('href') || '', location.href).href : ''
      };
    }).filter((row) => row.text).slice(0, ${js(limit)});
  })()`);
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
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
  columns: ["author", "text", "url"],
  func: async (page, kwargs) =>
    extractTweets(
      page as IPage,
      `https://x.com/${encodeURIComponent(str(kwargs.user).replace(/^@/, ""))}`,
      intArg(kwargs.limit, 20, 100),
    ),
});

cli({
  site: "twitter",
  name: "list-tweets",
  description: "Read tweets from a Twitter/X list",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "list", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["author", "text", "url"],
  func: async (page, kwargs) => {
    const list = str(kwargs.list);
    const url = list.startsWith("http")
      ? list
      : `https://x.com/i/lists/${encodeURIComponent(list)}`;
    return extractTweets(page as IPage, url, intArg(kwargs.limit, 20, 100));
  },
});

cli({
  site: "twitter",
  name: "list-add",
  description: "Add a Twitter/X user to a list from the browser UI",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  browser: true,
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
