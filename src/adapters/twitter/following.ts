/**
 * Twitter following — users that a user follows via GraphQL, paginated to `--limit`.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import { intArg } from "../_shared/browser-tools.js";
import {
  collectTimelineUsers,
  timelinePages,
  USER_COLUMNS,
  userIdArg,
} from "./client.js";

const QUERY_ID = "QPaR5ONQTW_KyiEXQCHP4g";
const ENDPOINT = "Following";

cli({
  site: "twitter",
  name: "following",
  description: "Get users that a user follows",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  args: [
    {
      name: "user",
      required: true,
      positional: true,
      description: "Handle (name or @name) or numeric user ID",
    },
    { name: "limit", type: "int", default: 20, description: "Number of users" },
  ],
  columns: USER_COLUMNS,
  func: async (_page, kwargs) => {
    const userId = await userIdArg(kwargs.user);
    const pages = timelinePages(
      ENDPOINT,
      QUERY_ID,
      { userId, count: 100, includePromotedContent: false },
      ["data", "user", "result", "timeline", "timeline", "instructions"],
    );
    return collectTimelineUsers(
      pages,
      intArg(kwargs.limit, 20, Number.POSITIVE_INFINITY),
    );
  },
});
