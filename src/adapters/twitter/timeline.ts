/**
 * Twitter timeline — home "For You" feed (HomeTimeline) or, with `--following`,
 * the chronological Following feed (HomeLatestTimeline) via GraphQL.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import { boolArg, intArg } from "../_shared/browser-tools.js";
import { TWEET_COLUMNS } from "./browser-extraction.js";
import { collectTimelineTweets, sinceArg, timelinePages } from "./client.js";

const FOR_YOU = { endpoint: "HomeTimeline", queryId: "fedFLLzmiCAuzPgA8lyh8Q" };
const FOLLOWING = {
  endpoint: "HomeLatestTimeline",
  queryId: "GjleyyGw4xvWe5tn8EQt9w",
};

cli({
  site: "twitter",
  name: "timeline",
  description:
    "Get home timeline (For You feed, or the chronological Following feed with --following)",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  args: [
    {
      name: "following",
      type: "bool",
      default: false,
      description: "Read the chronological Following feed",
    },
    { name: "limit", type: "int", default: 20, description: "Number of posts" },
    {
      name: "since",
      type: "str",
      description:
        "Keep posts at or after this ISO 8601 date or datetime; the Following feed stops at the first older post",
    },
  ],
  columns: TWEET_COLUMNS,
  func: async (_page, kwargs) => {
    const following = boolArg(kwargs.following);
    const { endpoint, queryId } = following ? FOLLOWING : FOR_YOU;
    const pages = timelinePages(
      endpoint,
      queryId,
      {
        count: 100,
        includePromotedContent: false,
        latestControlAvailable: true,
        requestContext: "launch",
      },
      ["data", "home", "home_timeline_urt", "instructions"],
    );
    return collectTimelineTweets(pages, {
      limit: intArg(kwargs.limit, 20, Number.POSITIVE_INFINITY),
      since: sinceArg(kwargs.since),
      stopAtSince: following,
    });
  },
});
