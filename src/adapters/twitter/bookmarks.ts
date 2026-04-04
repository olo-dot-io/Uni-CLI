/**
 * Twitter bookmarks — fetch authenticated user's bookmarks via GraphQL.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import {
  twitterFetch,
  FEATURES,
  extractTweetsFromInstructions,
} from "./client.js";

const QUERY_ID = "vOVTxp4izPYJBqbq8tpJCg";
const ENDPOINT = "Bookmarks";

cli({
  site: "twitter",
  name: "bookmarks",
  description: "Get your bookmarked tweets",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  columns: ["id", "author", "text", "likes", "retweets", "views", "url"],
  func: async (_page, kwargs) => {
    const count = Math.min((kwargs.limit as number) ?? 20, 50);

    const variables = {
      count,
      includePromotedContent: false,
    };

    const data = (await twitterFetch(
      ENDPOINT,
      QUERY_ID,
      variables,
      FEATURES,
    )) as Record<string, unknown>;

    // Navigate: data.bookmark_timeline_v2.timeline.instructions
    const root = data.data as Record<string, unknown> | undefined;
    const bookmarkTimeline = root?.bookmark_timeline_v2 as
      | Record<string, unknown>
      | undefined;
    const timeline = bookmarkTimeline?.timeline as
      | Record<string, unknown>
      | undefined;
    const instructions = (timeline?.instructions as unknown[]) ?? [];

    return extractTweetsFromInstructions(instructions);
  },
});
