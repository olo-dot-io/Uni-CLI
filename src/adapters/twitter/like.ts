/**
 * Twitter like — like a tweet via GraphQL FavoriteTweet mutation.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import { twitterPostFetch, FEATURES } from "./client.js";

const QUERY_ID = "lI07N6OFWm9H9H0JyNEdCA";
const ENDPOINT = "FavoriteTweet";

cli({
  site: "twitter",
  name: "like",
  description: "Like a tweet",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  args: [
    {
      name: "tweet_id",
      required: true,
      positional: true,
      description: "Tweet ID to like",
    },
  ],
  columns: ["status", "id"],
  func: async (_page, kwargs) => {
    const tweetId = String(kwargs.tweet_id);

    const variables = {
      tweet_id: tweetId,
    };

    await twitterPostFetch(ENDPOINT, QUERY_ID, variables, FEATURES);

    return [{ status: "ok", id: tweetId }];
  },
});
