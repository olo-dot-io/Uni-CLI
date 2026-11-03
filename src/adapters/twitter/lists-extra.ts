/**
 * @owner   src/adapters/twitter/lists-extra.ts
 * @does    Register browser-backed Twitter/X user timeline commands.
 * @needs   User-owned browser session on x.com, Twitter page readability checks, shared browser DOM extraction helpers.
 * @feeds   twitter.tweets, twitter.user-tweets, twitter.user-timeline.
 * @breaks  X/Twitter DOM or URL-shape drift can make timeline rows empty or misidentify tweet authors.
 * @invariants User timeline commands normalize @handles and emit the standard tweet row shape.
 * @side-effects Navigates the browser to X/Twitter profile pages.
 * @perf     Scrolls until the requested rows are collected or a scroll adds none.
 * @concurrency Browser session state is shared by the command runtime.
 * @test     src/adapters/twitter/lists-extra.test.ts
 * @stability stable
 * @since    2026-05-27
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { intArg, str } from "../_shared/browser-tools.js";
import { socialEmptyError } from "../../social/browser-errors.js";
import { assertTwitterReadable, gotoTwitterPage } from "./browser-state.js";
import {
  buildTwitterTweetExtractionScript,
  collectTweets,
  TWEET_COLUMNS,
} from "./browser-extraction.js";

export { buildTwitterTweetExtractionScript };

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

export async function extractTweets(
  page: IPage,
  url: string,
  limit: number,
  command: string,
): Promise<Record<string, unknown>[]> {
  await gotoTwitterPage(page, normalizeTwitterPageUrl(url), command);
  await page.autoScroll({ maxScrolls: 1, delay: 1000 });
  await assertTwitterReadable(page, command);
  const rows = await collectTweets(page, limit);
  if (rows.length > 0) return rows as unknown as Record<string, unknown>[];
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
      intArg(kwargs.limit, 20, Number.POSITIVE_INFINITY),
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
