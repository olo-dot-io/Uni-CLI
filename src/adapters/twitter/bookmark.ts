/**
 * Twitter bookmark — bookmark a tweet via GraphQL mutation.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import { twitterPostFetch, FEATURES } from "./client.js";

const QUERY_ID = "aoDbu3RHznuiSkQ9aNM67Q";
const ENDPOINT = "BookmarkTweet";

cli({
  site: "twitter",
  name: "bookmark",
  description: "Bookmark a tweet",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  args: [
    {
      name: "tweet_id",
      required: true,
      positional: true,
      description: "Tweet ID to bookmark",
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
