import { cli, Strategy } from "../../registry.js";
import type { AdapterArg, IPage } from "../../types.js";
import {
  clampLimit,
  mapRedditPosts,
  normalizeSubreddit,
  redditChildren,
  redditJson,
} from "./browser-utils.js";

const POST_COLUMNS = [
  "rank",
  "title",
  "subreddit",
  "author",
  "score",
  "comments",
  "url",
];

const LIMIT_ARG: AdapterArg = {
  name: "limit",
  type: "int",
  default: 20,
  description: "Number of posts",
};

const SUBREDDIT_ARG: AdapterArg = {
  name: "subreddit",
  type: "str",
  default: "",
  description: "Subreddit name without r/",
};

const TIME_ARG: AdapterArg = {
  name: "time",
  type: "str",
  default: "day",
  choices: ["hour", "day", "week", "month", "year", "all"],
  description: "Time window",
};

async function postsFromPath(
  page: IPage,
  path: string,
  kwargs: Record<string, unknown>,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<Array<Record<string, unknown>>> {
  const limit = clampLimit(kwargs.limit);
  const data = await redditJson(page, path, { limit, ...params });
  return mapRedditPosts(redditChildren(data), limit);
}

cli({
  site: "reddit",
  name: "hot",
  description: "Reddit front page hot posts",
  domain: "www.reddit.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [SUBREDDIT_ARG, LIMIT_ARG],
  columns: POST_COLUMNS,
  func: async (page, kwargs) => {
    const subreddit = normalizeSubreddit(kwargs.subreddit);
    const path = subreddit
      ? `/r/${encodeURIComponent(subreddit)}/hot.json`
      : "/r/all/hot.json";
    return postsFromPath(page as IPage, path, kwargs);
  },
});

cli({
  site: "reddit",
  name: "frontpage",
  description: "Reddit front page / r/all",
  domain: "www.reddit.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [LIMIT_ARG],
  columns: POST_COLUMNS,
  func: async (page, kwargs) =>
    postsFromPath(page as IPage, "/r/all.json", kwargs),
});

cli({
  site: "reddit",
  name: "popular",
  description: "Reddit popular posts (/r/popular)",
  domain: "www.reddit.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [LIMIT_ARG],
  columns: POST_COLUMNS,
  func: async (page, kwargs) =>
    postsFromPath(page as IPage, "/r/popular.json", kwargs),
});

cli({
  site: "reddit",
  name: "new",
  description: "Reddit newest posts",
  domain: "www.reddit.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [SUBREDDIT_ARG, LIMIT_ARG],
  columns: POST_COLUMNS,
  func: async (page, kwargs) => {
    const subreddit = normalizeSubreddit(kwargs.subreddit);
    const path = subreddit
      ? `/r/${encodeURIComponent(subreddit)}/new.json`
      : "/new.json";
    return postsFromPath(page as IPage, path, kwargs);
  },
});

cli({
  site: "reddit",
  name: "top",
  description: "Reddit top posts",
  domain: "www.reddit.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [SUBREDDIT_ARG, TIME_ARG, LIMIT_ARG],
  columns: POST_COLUMNS,
  func: async (page, kwargs) => {
    const subreddit = normalizeSubreddit(kwargs.subreddit);
    const path = subreddit
      ? `/r/${encodeURIComponent(subreddit)}/top.json`
      : "/top.json";
    return postsFromPath(page as IPage, path, kwargs, {
      t: String(kwargs.time ?? "day"),
    });
  },
});

cli({
  site: "reddit",
  name: "rising",
  description: "Reddit rising posts",
  domain: "www.reddit.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [SUBREDDIT_ARG, LIMIT_ARG],
  columns: POST_COLUMNS,
  func: async (page, kwargs) => {
    const subreddit = normalizeSubreddit(kwargs.subreddit);
    const path = subreddit
      ? `/r/${encodeURIComponent(subreddit)}/rising.json`
      : "/rising.json";
    return postsFromPath(page as IPage, path, kwargs);
  },
});

cli({
  site: "reddit",
  name: "subreddit",
  description: "Get posts from a specific subreddit",
  domain: "www.reddit.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "name",
      type: "str",
      required: true,
      positional: true,
      description: "Subreddit name",
    },
    {
      name: "sort",
      type: "str",
      default: "hot",
      choices: ["hot", "new", "top", "rising"],
      description: "Sort order",
    },
    TIME_ARG,
    LIMIT_ARG,
  ],
  columns: POST_COLUMNS,
  func: async (page, kwargs) => {
    const name = normalizeSubreddit(kwargs.name);
    const sort = String(kwargs.sort ?? "hot");
    const limit = clampLimit(kwargs.limit);
    const data = await redditJson(
      page as IPage,
      `/r/${encodeURIComponent(name)}/${sort}.json`,
      {
        limit,
        t: sort === "top" ? String(kwargs.time ?? "day") : undefined,
      },
    );
    return mapRedditPosts(redditChildren(data), limit);
  },
});

cli({
  site: "reddit",
  name: "trending",
  description: "Reddit trending subreddits",
  domain: "www.reddit.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [LIMIT_ARG],
  columns: ["name", "subscribers", "title", "description", "url"],
  func: async (page, kwargs) => {
    const limit = clampLimit(kwargs.limit, 25);
    const data = await redditJson(page as IPage, "/subreddits/popular.json", {
      limit,
    });
    return redditChildren(data)
      .slice(0, limit)
      .map((child) => {
        const item = (child.data ?? {}) as Record<string, unknown>;
        return {
          name: String(item.display_name ?? ""),
          subscribers: Number(item.subscribers ?? 0),
          title: String(item.title ?? ""),
          description: String(item.public_description ?? "").slice(0, 120),
          url: item.url ? `https://www.reddit.com${String(item.url)}` : "",
        };
      });
  },
});
