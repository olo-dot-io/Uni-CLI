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

cli({
  site: "twitter",
  name: "thread",
  description: "Get a tweet and its conversation thread",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  args: [
    {
      name: "tweet_id",
      required: true,
      positional: true,
      description: "Tweet ID (numeric)",
    },
  ],
  columns: ["id", "author", "text", "likes", "retweets", "views", "url"],
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

    return extractTweetsFromInstructions(instructions);
  },
});
