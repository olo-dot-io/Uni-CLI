/**
 * Twitter thread — fetch a tweet and its conversation thread via GraphQL TweetDetail.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import {
  twitterFetch,
  FEATURES,
  extractTweetsFromInstructions,
} from "./client.js";

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

cli({
  site: "twitter",
  name: "thread",
  description: "Get a tweet and its conversation thread",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  socialCapabilities: ["read", "comments", "comment_replies"],
  args: [
    {
      name: "tweet_id",
      required: true,
      positional: true,
      description: "Tweet ID (numeric)",
    },
  ],
  columns: [
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
  ],
  func: async (_page, kwargs) => {
    const tweetId = String(kwargs.tweet_id);

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
  },
});
