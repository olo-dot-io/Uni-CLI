/**
 * Twitter hide-reply — hide a reply to your tweet via GraphQL mutation.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import { twitterPostFetch, FEATURES } from "./client.js";

const QUERY_ID = "bZ-z9FBFBISzQ3LNL8b6nw";
const ENDPOINT = "HideReply";

cli({
  site: "twitter",
  name: "hide-reply",
  description: "Hide a reply to your tweet",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  args: [
    {
      name: "tweet_id",
      required: true,
      positional: true,
      description: "Reply tweet ID to hide",
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
