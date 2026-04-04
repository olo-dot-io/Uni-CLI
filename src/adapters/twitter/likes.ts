/**
 * Twitter likes — fetch a user's liked tweets via GraphQL.
 *
 * Requires the target user's numeric ID (use `unicli twitter profile <username>` to find it).
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import {
  twitterFetch,
  FEATURES,
  extractTweetsFromInstructions,
} from "./client.js";

const QUERY_ID = "eSSNbhECHHWWALkkQq-YTA";
const ENDPOINT = "Likes";

cli({
  site: "twitter",
  name: "likes",
  description: "Get a user's liked tweets",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  args: [
    {
      name: "user_id",
      required: true,
      positional: true,
      description: "User numeric ID",
    },
  ],
  columns: ["id", "author", "text", "likes", "retweets", "views", "url"],
  func: async (_page, kwargs) => {
    const userId = String(kwargs.user_id);
    const count = Math.min((kwargs.limit as number) ?? 20, 50);

    const variables = {
      userId,
      count,
      includePromotedContent: false,
    };

    const data = (await twitterFetch(
      ENDPOINT,
      QUERY_ID,
      variables,
      FEATURES,
    )) as Record<string, unknown>;

    // Navigate: data.user.result.timeline_v2.timeline.instructions
    const root = data.data as Record<string, unknown> | undefined;
    const user = root?.user as Record<string, unknown> | undefined;
    const result = user?.result as Record<string, unknown> | undefined;
    const timelineV2 = result?.timeline_v2 as
      | Record<string, unknown>
      | undefined;
    const timeline = timelineV2?.timeline as
      | Record<string, unknown>
      | undefined;
    const instructions = (timeline?.instructions as unknown[]) ?? [];

    return extractTweetsFromInstructions(instructions);
  },
});
