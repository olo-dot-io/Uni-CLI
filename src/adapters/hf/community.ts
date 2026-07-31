/**
 * @owner       src::adapters::hf::community
 * @does        Searches public Hugging Face forum discussions and normalizes matching posts with stable topic URLs.
 * @needs       Hugging Face Discourse search JSON, shared HTML-to-Markdown conversion, adapter registry
 * @feeds       hf.community and registry-driven AI community search
 * @breaks      Discourse response drift or unstable topic linking hides current community evidence or corrupts engagement metrics.
 * @invariants  Every returned row has a topic id, title, source URL, author, and retrieval-compatible timestamp fields; likes use post.like_count and replies use topic.reply_count.
 * @side-effects One public HTTPS GET per invocation.
 * @perf        O(P + T), bounded by the requested result limit and Discourse page size.
 * @concurrency safe
 * @test        tests/unit/adapters/hf-community.test.ts, live hf.community probe
 * @stability   experimental
 * @since       2026-07-17
 */

import { htmlToMarkdown } from "../../engine/html-to-markdown.js";
import { cli, Strategy } from "../../registry.js";

const HF_FORUM = "https://discuss.huggingface.co";
const REQUEST_TIMEOUT_MS = 15_000;

interface HfForumPost {
  id?: unknown;
  topic_id?: unknown;
  post_number?: unknown;
  username?: unknown;
  created_at?: unknown;
  like_count?: unknown;
  blurb?: unknown;
}

interface HfForumTopic {
  id?: unknown;
  title?: unknown;
  slug?: unknown;
  category_id?: unknown;
  reply_count?: unknown;
  views?: unknown;
  last_posted_at?: unknown;
}

interface HfForumSearchResponse {
  posts?: unknown;
  topics?: unknown;
}

function positiveInt(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 100) {
    throw new Error("limit must be an integer between 1 and 100.");
  }
  return parsed;
}

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function number(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function mapHfCommunityRows(
  response: HfForumSearchResponse,
  limit: number,
): Array<Record<string, unknown>> {
  const topics = Array.isArray(response.topics)
    ? (response.topics as HfForumTopic[])
    : [];
  const topicById = new Map(
    topics.map((topic) => [text(topic.id), topic] as const),
  );
  const posts = Array.isArray(response.posts)
    ? (response.posts as HfForumPost[])
    : [];

  return posts
    .filter((post) => topicById.has(text(post.topic_id)))
    .slice(0, limit)
    .map((post) => {
      const topicId = text(post.topic_id);
      const topic = topicById.get(topicId);
      const slug = text(topic?.slug) || "topic";
      const postNumber = text(post.post_number) || "1";
      return {
        id: text(post.id),
        topic_id: topicId,
        title: text(topic?.title),
        author: text(post.username),
        createdAt: text(post.created_at),
        updatedAt: text(topic?.last_posted_at),
        likes: number(post.like_count),
        replies: number(topic?.reply_count),
        views: number(topic?.views),
        category_id: number(topic?.category_id),
        summary: htmlToMarkdown(text(post.blurb)).replace(/\s+/g, " ").trim(),
        url: `${HF_FORUM}/t/${encodeURIComponent(slug)}/${encodeURIComponent(topicId)}/${encodeURIComponent(postNumber)}`,
      };
    });
}

async function searchHfCommunity(
  query: string,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const url = new URL(`${HF_FORUM}/search.json`);
  url.searchParams.set("q", query);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: "application/json",
      "User-Agent": "unicli-hf-community/1.0",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Hugging Face community search returned HTTP ${response.status}.`,
    );
  }
  return mapHfCommunityRows(
    (await response.json()) as HfForumSearchResponse,
    limit,
  );
}

cli({
  site: "hf",
  name: "community",
  description: "Search current Hugging Face forum discussions and posts",
  domain: "discuss.huggingface.co",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "Free-text forum search query",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Maximum matching posts (1-100)",
    },
  ],
  columns: [
    "title",
    "author",
    "createdAt",
    "updatedAt",
    "likes",
    "replies",
    "views",
    "url",
    "summary",
  ],
  operation_effect: "read",
  execution_operator: "structured-api",
  retrieval: {
    operation: "discover",
    result_kind: "discussion",
    source_class: "community",
    arguments: { query: "query", limit: "limit" },
  },
  capabilities: ["http.fetch"],
  minimum_capability: "http.fetch",
  func: async (_page, kwargs) => {
    const query = text(kwargs.query).trim();
    if (!query) throw new Error("query cannot be empty.");
    return searchHfCommunity(query, positiveInt(kwargs.limit, 20));
  },
});
