/**
 * Twitter search — keyword search using GraphQL SearchTimeline endpoint.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import {
  twitterFetch,
  FEATURES,
  extractTweetsFromInstructions,
} from "./client.js";

const QUERY_ID = "nK1dw4oV3k4w5TdtcAdSww";
const ENDPOINT = "SearchTimeline";

cli({
  site: "twitter",
  name: "search",
  description: "Search tweets by keyword",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  args: [
    {
      name: "query",
      required: true,
      positional: true,
      description: "Search query",
    },
  ],
  columns: ["id", "author", "text", "likes", "retweets", "views", "url"],
  func: async (_page, kwargs) => {
    const query = kwargs.query as string;
    const count = Math.min((kwargs.limit as number) ?? 20, 50);

    const variables = {
      rawQuery: query,
      count,
      querySource: "typed_query",
      product: "Latest",
    };

    const data = (await twitterFetch(
      ENDPOINT,
      QUERY_ID,
      variables,
      FEATURES,
    )) as Record<string, unknown>;

    // Navigate: data.search_by_raw_query.search_timeline.timeline.instructions
    const searchByRawQuery = data.data as Record<string, unknown> | undefined;
    const searchResult = searchByRawQuery?.search_by_raw_query as
      | Record<string, unknown>
      | undefined;
    const searchTimeline = searchResult?.search_timeline as
      | Record<string, unknown>
      | undefined;
    const timeline = searchTimeline?.timeline as
      | Record<string, unknown>
      | undefined;
    const instructions = (timeline?.instructions as unknown[]) ?? [];

    return extractTweetsFromInstructions(instructions);
  },
});
