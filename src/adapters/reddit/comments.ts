/**
 * @owner   Reddit comments adapter.
 * @does    Fetches a Reddit post comment listing and emits normalized nested comment rows.
 * @needs   Public reddit JSON listing endpoint and a normal web User-Agent.
 * @feeds   Social comment tree analysis and Reddit read workflows.
 * @breaks  Reddit JSON schema or public endpoint access changes can block unauthenticated reads.
 */

import { USER_AGENT } from "../../constants.js";
import { cli, Strategy } from "../../registry.js";
import { normalizeCommentRows } from "../../social/comments.js";

interface RedditListing {
  data?: {
    children?: RedditThing[];
  };
}

interface RedditThing {
  kind?: string;
  data?: RedditCommentData;
}

interface RedditCommentData {
  id?: string;
  name?: string;
  parent_id?: string;
  author?: string;
  body?: string;
  score?: number;
  created_utc?: number;
  replies?: "" | RedditListing;
}

function normalizePostPath(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error("Reddit post URL or ID is required");
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    return url.pathname.replace(/^\/+/, "").replace(/\.json$/, "");
  }
  return raw.replace(/^\/+/, "").replace(/\.json$/, "");
}

function collectCommentRows(
  listing: RedditListing,
  contentId: string,
  parentId = "",
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const thing of listing.data?.children ?? []) {
    if (thing.kind !== "t1") continue;
    const data = thing.data;
    if (!data?.id) continue;
    const commentId = data.name ?? `t1_${data.id}`;
    rows.push({
      id: commentId,
      parent_id:
        data.parent_id && data.parent_id.startsWith("t1_")
          ? data.parent_id
          : parentId,
      author: data.author ?? "",
      body: data.body ?? "",
      text: data.body ?? "",
      score: data.score ?? 0,
      replies:
        data.replies && typeof data.replies === "object"
          ? (data.replies.data?.children?.filter((child) => child.kind === "t1")
              .length ?? 0)
          : 0,
      created: data.created_utc
        ? new Date(data.created_utc * 1000).toISOString()
        : "",
      content_id: contentId,
    });
    if (data.replies && typeof data.replies === "object") {
      rows.push(...collectCommentRows(data.replies, contentId, commentId));
    }
  }
  return rows;
}

export function extractRedditCommentRows(
  response: unknown,
  contentId: string,
): Array<Record<string, unknown>> {
  if (!Array.isArray(response) || response.length < 2) {
    throw new Error("Unexpected Reddit comments response");
  }
  return collectCommentRows(response[1] as RedditListing, contentId);
}

cli({
  site: "reddit",
  name: "comments",
  description: "Reddit post comments with nested reply hierarchy",
  domain: "www.reddit.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "url",
      required: true,
      positional: true,
      description: "Reddit post URL, path, or comments ID",
      "x-unicli-accepts": ["url", "id"],
    },
    {
      name: "sort",
      default: "top",
      choices: ["best", "top", "new", "controversial", "old", "qa"],
      description: "Comment sort order",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of top-level comments",
    },
  ],
  columns: [
    "platform",
    "content_id",
    "comment_id",
    "parent_id",
    "depth",
    "path",
    "author",
    "text",
    "likes",
    "replies",
    "created",
    "body",
    "score",
  ],
  socialCapabilities: ["read", "comments", "comment_replies"],
  func: async (_page, kwargs) => {
    const postPath = normalizePostPath(String(kwargs.url ?? ""));
    const sort = String(kwargs.sort ?? "top");
    const limit = Number(kwargs.limit ?? 20);
    const response = await fetch(
      `https://www.reddit.com/${postPath}.json?sort=${encodeURIComponent(sort)}&limit=${encodeURIComponent(String(limit))}&raw_json=1`,
      {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
      },
    );
    if (!response.ok) {
      throw new Error(`Reddit comments request failed: ${response.status}`);
    }
    const json = await response.json();
    const rows = extractRedditCommentRows(json, postPath);
    return normalizeCommentRows(rows, {
      platform: "reddit",
      contentId: postPath,
    });
  },
});
