/**
 * Twitter profile — user profile lookup via REST v1.1 API.
 *
 * Uses /1.1/users/show.json which is simpler than the GraphQL alternative.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import { twitterRestFetch } from "./client.js";

cli({
  site: "twitter",
  name: "profile",
  description: "Get user profile information",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  args: [
    {
      name: "username",
      required: true,
      positional: true,
      description: "Twitter username (without @)",
    },
  ],
  columns: [
    "id",
    "name",
    "screen_name",
    "followers",
    "following",
    "tweets",
    "description",
  ],
  func: async (_page, kwargs) => {
    const username = kwargs.username as string;

    const data = (await twitterRestFetch("/1.1/users/show.json", {
      screen_name: username,
    })) as Record<string, unknown>;

    return [
      {
        id: String(data.id),
        name: data.name as string,
        screen_name: data.screen_name as string,
        followers: data.followers_count as number,
        following: data.friends_count as number,
        tweets: data.statuses_count as number,
        description: data.description as string,
      },
    ];
  },
});
