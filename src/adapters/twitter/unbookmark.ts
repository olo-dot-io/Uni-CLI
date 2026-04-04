/**
 * Twitter unbookmark — remove a bookmark via GraphQL mutation.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import { twitterPostFetch, FEATURES } from "./client.js";

const QUERY_ID = "Wlmlj2-xISVIqR-TU4LZ0g";
const ENDPOINT = "DeleteBookmark";

cli({
  site: "twitter",
  name: "unbookmark",
  description: "Remove a bookmark from a tweet",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  args: [
    {
      name: "tweet_id",
      required: true,
      positional: true,
      description: "Tweet ID to unbookmark",
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
