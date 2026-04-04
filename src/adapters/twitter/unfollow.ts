/**
 * Twitter unfollow — unfollow a user via GraphQL mutation.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import { twitterPostFetch, FEATURES } from "./client.js";

const QUERY_ID = "2VLdHTIKqAR3MsBfq3JnBw";
const ENDPOINT = "Unfollow";

cli({
  site: "twitter",
  name: "unfollow",
  description: "Unfollow a user",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  args: [
    {
      name: "user_id",
      required: true,
      positional: true,
      description: "User numeric ID to unfollow",
    },
  ],
  columns: ["status", "id"],
  func: async (_page, kwargs) => {
    const userId = String(kwargs.user_id);

    const variables = {
      user_id: userId,
    };

    await twitterPostFetch(ENDPOINT, QUERY_ID, variables, FEATURES);

    return [{ status: "ok", id: userId }];
  },
});
