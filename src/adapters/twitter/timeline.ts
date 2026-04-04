/**
 * Twitter timeline — home "For You" timeline via GraphQL HomeTimeline endpoint.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import {
  twitterFetch,
  FEATURES,
  extractTweetsFromInstructions,
} from "./client.js";

const QUERY_ID = "c-CzHF1LboFilMpsx4ZCrQ";
const ENDPOINT = "HomeTimeline";

cli({
  site: "twitter",
  name: "timeline",
  description: "Get home timeline (for-you feed)",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  columns: ["id", "author", "text", "likes", "retweets", "views", "url"],
  func: async (_page, kwargs) => {
    const count = Math.min((kwargs.limit as number) ?? 20, 50);

    const variables = {
      count,
      includePromotedContent: false,
      latestControlAvailable: true,
      requestContext: "launch",
    };

    const data = (await twitterFetch(
      ENDPOINT,
      QUERY_ID,
      variables,
      FEATURES,
    )) as Record<string, unknown>;

    // Navigate: data.home.home_timeline_urt.instructions
    const root = data.data as Record<string, unknown> | undefined;
    const home = root?.home as Record<string, unknown> | undefined;
    const homeTimelineUrt = home?.home_timeline_urt as
      | Record<string, unknown>
      | undefined;
    const instructions = (homeTimelineUrt?.instructions as unknown[]) ?? [];

    return extractTweetsFromInstructions(instructions);
  },
});
