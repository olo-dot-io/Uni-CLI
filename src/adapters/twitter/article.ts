/**
 * Twitter article — fetch a Twitter article/note content via GraphQL TweetDetail.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import { twitterFetch, FEATURES } from "./client.js";

const QUERY_ID = "xOhkmRac04YFZmOzU9PJHg";
const ENDPOINT = "TweetDetail";

cli({
  site: "twitter",
  name: "article",
  description: "Get Twitter article/note content from a tweet",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  args: [
    {
      name: "tweet_id",
      required: true,
      positional: true,
      description: "Tweet ID containing the article/note",
    },
  ],
  columns: ["id", "author", "title", "text", "url"],
  func: async (_page, kwargs) => {
    const tweetId = String(kwargs.tweet_id);

    const variables = {
      focalTweetId: tweetId,
      with_rux_injections: false,
      includePromotedContent: false,
      withCommunity: true,
      withQuickPromoteEligibilityTweetFields: false,
      withBirdwatchNotes: false,
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

    for (const instruction of instructions) {
      const inst = instruction as Record<string, unknown>;
      if ((inst.type as string) !== "TimelineAddEntries") continue;

      const entries = (inst.entries as unknown[]) ?? [];
      for (const entry of entries) {
        const e = entry as Record<string, unknown>;
        const content = e.content as Record<string, unknown> | undefined;
        if (!content) continue;

        const itemContent = content.itemContent as
          | Record<string, unknown>
          | undefined;
        if (!itemContent) continue;

        const tweetResults = itemContent.tweet_results as
          | Record<string, unknown>
          | undefined;
        const result = tweetResults?.result as
          | Record<string, unknown>
          | undefined;
        if (!result) continue;

        // Unwrap tweet_with_visibility_results
        const tweetObj = (result.tweet ?? result) as Record<string, unknown>;
        const restId = tweetObj.rest_id as string | undefined;
        if (restId !== tweetId) continue;

        const core = tweetObj.core as Record<string, unknown> | undefined;
        const userResults = core?.user_results as
          | Record<string, unknown>
          | undefined;
        const userResult = userResults?.result as
          | Record<string, unknown>
          | undefined;
        const userLegacy = userResult?.legacy as
          | Record<string, unknown>
          | undefined;
        const screenName = (userLegacy?.screen_name as string) ?? "unknown";

        // Extract note/article content from note_tweet
        const noteTweet = tweetObj.note_tweet as
          | Record<string, unknown>
          | undefined;
        const noteTweetResults = noteTweet?.note_tweet_results as
          | Record<string, unknown>
          | undefined;
        const noteResult = noteTweetResults?.result as
          | Record<string, unknown>
          | undefined;
        const noteText = (noteResult?.text as string) ?? "";

        // Fallback to legacy full_text if no note content
        const legacy = tweetObj.legacy as Record<string, unknown> | undefined;
        const fullText = (legacy?.full_text as string) ?? "";

        const articleText = noteText || fullText;

        // Extract title from card if present
        const card = tweetObj.card as Record<string, unknown> | undefined;
        const cardLegacy = card?.legacy as Record<string, unknown> | undefined;
        const bindingValues = (cardLegacy?.binding_values as unknown[]) ?? [];

        let title = "";
        for (const bv of bindingValues) {
          const binding = bv as Record<string, unknown>;
          if ((binding.key as string) === "title") {
            const stringValue = binding.string_value as string | undefined;
            if (stringValue) title = stringValue;
          }
        }

        return [
          {
            id: restId,
            author: screenName,
            title,
            text: articleText,
            url: `https://x.com/${screenName}/status/${restId}`,
          },
        ];
      }
    }

    return [];
  },
});
