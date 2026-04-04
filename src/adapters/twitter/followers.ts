/**
 * Twitter followers — fetch a user's followers list via GraphQL.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import {
  twitterFetch,
  FEATURES,
  extractUsersFromInstructions,
} from "./client.js";

const QUERY_ID = "djdTXDIk2qhd1OEe-buj5A";
const ENDPOINT = "Followers";

cli({
  site: "twitter",
  name: "followers",
  description: "Get a user's followers",
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
  columns: [
    "id",
    "name",
    "screen_name",
    "followers",
    "following",
    "description",
  ],
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

    // Navigate: data.user.result.timeline.timeline.instructions
    const root = data.data as Record<string, unknown> | undefined;
    const user = root?.user as Record<string, unknown> | undefined;
    const result = user?.result as Record<string, unknown> | undefined;
    const timelineObj = result?.timeline as Record<string, unknown> | undefined;
    const timeline = timelineObj?.timeline as
      | Record<string, unknown>
      | undefined;
    const instructions = (timeline?.instructions as unknown[]) ?? [];

    return extractUsersFromInstructions(instructions);
  },
});
