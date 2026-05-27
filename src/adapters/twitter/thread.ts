/**
 * @owner   src/adapters/twitter/thread.ts
 * @does    Register Twitter/X tweet thread and comments commands over the GraphQL TweetDetail operation.
 * @needs   Twitter cookie auth with ct0/auth_token, TweetDetail GraphQL operation, tweet ID or status URL input.
 * @feeds   twitter.thread, twitter.comments, social.comments twitter.
 * @breaks  TweetDetail query-id drift or invalid tweet target parsing returns empty comment trees.
 * @invariants Thread rows preserve root/reply hierarchy fields over the standard tweet row shape.
 * @side-effects Performs authenticated read requests to x.com.
 * @perf     One GraphQL request per command invocation.
 * @concurrency Stateless per invocation.
 * @test     src/adapters/twitter/thread.test.ts
 * @stability stable
 * @since    2026-05-27
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import type { SocialCapability } from "../../types.js";
import {
  twitterFetch,
  FEATURES,
  extractTweetsFromInstructions,
} from "./client.js";
import { parseTwitterTweetUrl } from "./tweet-url.js";

const QUERY_ID = "B9_KmbkLhXt6jRwGjJrweg";
const ENDPOINT = "TweetDetail";

interface TweetRow {
  id: string;
  author: string;
  text: string;
  likes: number;
  retweets: number;
  views: string;
  url: string;
}

export function normalizeTwitterThreadRows(
  tweetId: string,
  tweets: TweetRow[],
): Array<TweetRow & { parent_id: string; depth: number; path: string }> {
  let replyRank = 0;
  return tweets.map((tweet) => {
    const isRoot = tweet.id === tweetId;
    if (!isRoot) replyRank += 1;
    return {
      ...tweet,
      parent_id: isRoot ? "" : tweetId,
      depth: isRoot ? 0 : 1,
      path: isRoot ? "0001" : `0001.${String(replyRank).padStart(4, "0")}`,
    };
  });
}

export function resolveTwitterThreadTweetId(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (/^\d+$/.test(raw)) return raw;
  return parseTwitterTweetUrl(raw).id;
}

async function fetchTwitterThread(
  tweetTarget: unknown,
): Promise<
  Array<TweetRow & { parent_id: string; depth: number; path: string }>
> {
  const tweetId = resolveTwitterThreadTweetId(tweetTarget);

  const variables = {
    focalTweetId: tweetId,
    with_rux_injections: false,
    includePromotedContent: false,
    withCommunity: true,
    withQuickPromoteEligibilityTweetFields: false,
    withBirdwatchNotes: true,
    withVoice: true,
    withV2Timeline: true,
  };

  const data = (await twitterFetch(
    ENDPOINT,
    QUERY_ID,
    variables,
    FEATURES,
  )) as Record<string, unknown>;

  // Navigate: data.threaded_conversation_with_injections_v2.instructions
  const root = data.data as Record<string, unknown> | undefined;
  const conversation = root?.threaded_conversation_with_injections_v2 as
    | Record<string, unknown>
    | undefined;
  const instructions = (conversation?.instructions as unknown[]) ?? [];

  return normalizeTwitterThreadRows(
    tweetId,
    extractTweetsFromInstructions(instructions),
  );
}

const THREAD_SOCIAL_CAPABILITIES: SocialCapability[] = [
  "read",
  "comments",
  "comment_replies",
];

const THREAD_COLUMNS = [
  "id",
  "parent_id",
  "author",
  "text",
  "likes",
  "retweets",
  "views",
  "url",
  "depth",
  "path",
];

cli({
  site: "twitter",
  name: "thread",
  description: "Get a tweet and its conversation thread",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  socialCapabilities: THREAD_SOCIAL_CAPABILITIES,
  args: [
    {
      name: "tweet_id",
      required: true,
      positional: true,
      description: "Tweet ID or Twitter/X status URL",
    },
  ],
  columns: THREAD_COLUMNS,
  func: async (_page, kwargs) => fetchTwitterThread(kwargs.tweet_id),
});

cli({
  site: "twitter",
  name: "comments",
  description: "Get replies/comments for a Twitter/X tweet",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  socialCapabilities: THREAD_SOCIAL_CAPABILITIES,
  args: [
    {
      name: "url",
      required: true,
      positional: true,
      description: "Tweet ID or Twitter/X status URL",
    },
  ],
  columns: THREAD_COLUMNS,
  func: async (_page, kwargs) => fetchTwitterThread(kwargs.url),
});
