/**
 * Twitter delete — delete own tweet via GraphQL DeleteTweet mutation.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import { twitterPostFetch, FEATURES } from "./client.js";

const QUERY_ID = "VaenaVgh5q5ih7kvyVjgtg";
const ENDPOINT = "DeleteTweet";

cli({
  site: "twitter",
  name: "delete",
  description: "Delete your own tweet",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  args: [
    {
      name: "tweet_id",
      required: true,
      positional: true,
      description: "Tweet ID to delete",
    },
  ],
  columns: ["status", "id"],
  func: async (_page, kwargs) => {
    const tweetId = String(kwargs.tweet_id);

    const variables = {
      tweet_id: tweetId,
      dark_request: false,
    };

    await twitterPostFetch(ENDPOINT, QUERY_ID, variables, FEATURES);

    return [{ status: "ok", id: tweetId }];
  },
});
