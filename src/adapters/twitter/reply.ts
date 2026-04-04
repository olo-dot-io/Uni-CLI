/**
 * Twitter reply — reply to a tweet via GraphQL CreateTweet mutation.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import { twitterPostFetch, FEATURES } from "./client.js";

const QUERY_ID = "bDE2rBtZb3uyrczSZ_pI9g";
const ENDPOINT = "CreateTweet";

cli({
  site: "twitter",
  name: "reply",
  description: "Reply to a tweet",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  args: [
    {
      name: "tweet_id",
      required: true,
      positional: true,
      description: "Tweet ID to reply to",
    },
    {
      name: "text",
      required: true,
      description: "Reply text content",
    },
  ],
  columns: ["status", "id", "url"],
  func: async (_page, kwargs) => {
    const tweetId = String(kwargs.tweet_id);
    const text = kwargs.text as string;

    const variables = {
      tweet_text: text,
      reply: {
        in_reply_to_tweet_id: tweetId,
        exclude_reply_user_ids: [],
      },
      dark_request: false,
      media: {
        media_entities: [],
        possibly_sensitive: false,
      },
      semantic_annotation_ids: [],
    };

    const data = (await twitterPostFetch(
      ENDPOINT,
      QUERY_ID,
      variables,
      FEATURES,
    )) as Record<string, unknown>;

    const root = data.data as Record<string, unknown> | undefined;
    const createTweet = root?.create_tweet as
      | Record<string, unknown>
      | undefined;
    const tweetResults = createTweet?.tweet_results as
      | Record<string, unknown>
      | undefined;
    const result = tweetResults?.result as Record<string, unknown> | undefined;
    const restId = (result?.rest_id as string) ?? "";

    return [
      {
        status: "ok",
        id: restId,
        url: restId ? `https://x.com/i/status/${restId}` : "",
      },
    ];
  },
});
