/**
 * @owner       src::adapters::linux-do::read
 * @does        Registers Linux.do listing, taxonomy, topic, and user-history reads.
 * @needs       browser-json same-origin authenticated JSON client.
 * @feeds       Linux.do CLI, MCP, and intent-routing surfaces.
 * @breaks      Discourse payload drift surfaces as empty fields rather than changing authentication substrate.
 * @invariants  Every command is read-only, browser-protocol backed, and requires a signed-in user session.
 * @side-effects Same-origin browser navigation and fetch only.
 * @perf        Each command performs one bounded endpoint request and maps at most 100 records.
 * @concurrency One broker-owned browser page per invocation.
 * @test        src/adapters/linux-do/browser-json.test.ts
 * @stability   experimental
 * @since       2026-07-31
 */

import { cli, Strategy } from "../../registry.js";
import { stripHtml } from "../../engine/text-normalize.js";
import type { IPage, OperationFamily } from "../../types.js";
import { fetchLinuxDoJson } from "./browser-json.js";
import "./site.js";

const SITE = "linux-do";
const DOMAIN = "linux.do";
const MAX_LIMIT = 100;

const browserReadContract = {
  site: SITE,
  domain: DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  target_surface: "web" as const,
  operation_effect: "read" as const,
  execution_operator: "browser-protocol" as const,
  idempotency: "guaranteed" as const,
  auth_requirement: "required" as const,
  capabilities: ["cdp-browser.navigate", "cdp-browser.evaluate"],
  minimum_capability: "cdp-browser.evaluate",
};

function limitOf(value: unknown, fallback = 20): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(parsed)));
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readFamily(operation_family: OperationFamily): {
  operation_family: OperationFamily;
} {
  return { operation_family };
}

cli({
  ...browserReadContract,
  ...readFamily("list"),
  name: "categories",
  description: "List all Linux.do forum categories",
  args: [
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of categories",
    },
  ],
  columns: ["name", "slug", "id", "topics", "description"],
  func: async (page, kwargs, context) => {
    const data = await fetchLinuxDoJson(
      page as IPage,
      "/categories.json",
      context.signal,
    );
    return records(record(data.category_list).categories)
      .slice(0, limitOf(kwargs.limit))
      .map((item) => ({
        name: text(item.name),
        slug: text(item.slug),
        id: number(item.id),
        topics: number(item.topic_count),
        description: text(item.description_text).slice(0, 80),
      }));
  },
});

cli({
  ...browserReadContract,
  ...readFamily("list"),
  name: "category",
  description: "Topics in a Linux.do category",
  args: [
    {
      name: "slug",
      required: true,
      positional: true,
      description: "Category slug (e.g. dev, share)",
    },
    {
      name: "id",
      required: true,
      positional: true,
      type: "int",
      description: "Category ID",
      "x-unicli-kind": "id",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of topics",
    },
  ],
  columns: ["title", "views", "replies", "likes", "created"],
  func: async (page, kwargs, context) => {
    const slug = encodeURIComponent(text(kwargs.slug));
    const id = number(kwargs.id);
    const data = await fetchLinuxDoJson(
      page as IPage,
      `/c/${slug}/${id}.json`,
      context.signal,
    );
    return records(record(data.topic_list).topics)
      .slice(0, limitOf(kwargs.limit))
      .map((item) => ({
        title: text(item.title),
        views: number(item.views),
        replies: Math.max(0, number(item.posts_count, 1) - 1),
        likes: number(item.like_count),
        created: text(item.created_at),
        url: `https://linux.do/t/topic/${text(item.id)}`,
      }));
  },
});

async function topicListing(
  page: IPage,
  path: string,
  limit: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const data = await fetchLinuxDoJson(page, path, signal);
  return records(record(data.topic_list).topics)
    .slice(0, limitOf(limit))
    .map((item) => ({
      title: text(item.title),
      views: number(item.views),
      replies: Math.max(0, number(item.posts_count, 1) - 1),
      likes: number(item.like_count),
      created: text(item.created_at),
      url: `https://linux.do/t/topic/${text(item.id)}`,
    }));
}

for (const listing of [
  {
    name: "feed",
    description: "Linux.do personal feed (new topics)",
    path: "/new.json",
  },
  {
    name: "hot",
    description: "Linux.do hot topics",
    path: "/top.json?period=daily",
  },
  {
    name: "latest",
    description: "Linux.do latest topics",
    path: "/latest.json",
  },
] as const) {
  cli({
    ...browserReadContract,
    ...readFamily("list"),
    name: listing.name,
    description: listing.description,
    args: [
      {
        name: "limit",
        type: "int",
        default: 20,
        description: "Number of topics",
      },
    ],
    columns:
      listing.name === "hot"
        ? ["rank", "title", "views", "replies", "likes"]
        : ["title", "views", "replies", "likes", "created"],
    func: async (page, kwargs, context) => {
      const rows = await topicListing(
        page as IPage,
        listing.path,
        kwargs.limit,
        context.signal,
      );
      return listing.name === "hot"
        ? rows.map((row, index) => ({ rank: index + 1, ...row }))
        : rows;
    },
  });
}

cli({
  ...browserReadContract,
  ...readFamily("list"),
  name: "tags",
  description: "List Linux.do forum tags",
  args: [
    {
      name: "limit",
      type: "int",
      default: 30,
      description: "Number of tags",
    },
  ],
  columns: ["rank", "name", "count", "url"],
  func: async (page, kwargs, context) => {
    const data = await fetchLinuxDoJson(
      page as IPage,
      "/tags.json",
      context.signal,
    );
    return records(data.tags)
      .sort((left, right) => number(right.count) - number(left.count))
      .slice(0, limitOf(kwargs.limit, 30))
      .map((item, index) => ({
        rank: index + 1,
        name: text(item.name || item.id),
        count: number(item.count),
        url: `https://linux.do/tag/${text(item.slug || item.name)}`,
      }));
  },
});

cli({
  ...browserReadContract,
  ...readFamily("get"),
  name: "topic",
  description: "Linux.do topic detail and replies",
  args: [
    {
      name: "id",
      required: true,
      positional: true,
      type: "int",
      description: "Topic ID",
      "x-unicli-kind": "id",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of posts to show",
    },
  ],
  columns: ["author", "content", "likes", "created"],
  func: async (page, kwargs, context) => {
    const data = await fetchLinuxDoJson(
      page as IPage,
      `/t/${number(kwargs.id)}.json`,
      context.signal,
    );
    return records(record(data.post_stream).posts)
      .slice(0, limitOf(kwargs.limit))
      .map((item) => ({
        author: text(item.username),
        content: stripHtml(text(item.cooked)).slice(0, 200),
        likes: number(item.like_count),
        created: text(item.created_at),
      }));
  },
});

cli({
  ...browserReadContract,
  ...readFamily("list"),
  name: "user-posts",
  description: "Linux.do user posts (replies)",
  args: [
    {
      name: "username",
      required: true,
      positional: true,
      description: "Username",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of posts",
    },
  ],
  columns: ["rank", "author", "topic", "content", "created", "url"],
  func: async (page, kwargs, context) => {
    const limit = limitOf(kwargs.limit);
    const username = encodeURIComponent(text(kwargs.username));
    const data = await fetchLinuxDoJson(
      page as IPage,
      `/user_actions.json?username=${username}&filter=5&offset=0&limit=${limit}`,
      context.signal,
    );
    return records(data.user_actions)
      .slice(0, limit)
      .map((item, index) => ({
        rank: index + 1,
        author: text(item.acting_username || item.username),
        topic: text(item.title),
        content: stripHtml(text(item.excerpt)).slice(0, 200),
        created: text(item.created_at),
        url: `https://linux.do/t/topic/${text(item.topic_id)}/${text(item.post_number)}`,
      }));
  },
});

cli({
  ...browserReadContract,
  ...readFamily("list"),
  name: "user-topics",
  description: "Linux.do topics created by a user",
  args: [
    {
      name: "username",
      required: true,
      positional: true,
      description: "Username",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of topics",
    },
  ],
  columns: ["rank", "title", "replies", "likes", "views", "created", "url"],
  func: async (page, kwargs, context) => {
    const username = encodeURIComponent(text(kwargs.username));
    const data = await fetchLinuxDoJson(
      page as IPage,
      `/topics/created-by/${username}.json`,
      context.signal,
    );
    return records(record(data.topic_list).topics)
      .slice(0, limitOf(kwargs.limit))
      .map((item, index) => ({
        rank: index + 1,
        title: text(item.fancy_title || item.title),
        replies: Math.max(0, number(item.posts_count, 1) - 1),
        likes: number(item.like_count),
        views: number(item.views),
        created: text(item.created_at),
        url: `https://linux.do/t/topic/${text(item.id)}`,
      }));
  },
});
