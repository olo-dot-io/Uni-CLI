/**
 * @owner   Zhihu comment adapter.
 * @does    Reads Zhihu answer/article comments and normalizes nested child comments.
 * @needs   Zhihu comment_v5 API and z_c0 cookie for authenticated access.
 * @feeds   Social comment tree analysis for Zhihu answers and articles.
 * @breaks  Zhihu API shape, auth cookie requirements, or anti-bot policy changes.
 */

import { USER_AGENT } from "../../constants.js";
import {
  loadCookiesWithCDP,
  formatCookieHeader,
} from "../../engine/cookies.js";
import { cli, Strategy } from "../../registry.js";
import { normalizeCommentRows } from "../../social/comments.js";

interface ZhihuAuthor {
  name?: string;
}

interface ZhihuComment {
  id?: string | number;
  author?: ZhihuAuthor;
  content?: string;
  like_count?: number;
  child_comment_count?: number;
  created_time?: number;
  child_comments?: ZhihuComment[];
  reply_to_author?: ZhihuAuthor;
}

interface ZhihuCommentResponse {
  data?: ZhihuComment[];
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function zhihuCreated(value: number | undefined): string {
  return value ? new Date(value * 1000).toISOString() : "";
}

function zhihuCommentToRow(
  item: ZhihuComment,
  parentId = "",
): Record<string, unknown> {
  const id = item.id === undefined ? "" : String(item.id);
  return {
    id,
    parent_id: parentId,
    author: item.author?.name ?? "",
    content: stripHtml(item.content ?? ""),
    text: stripHtml(item.content ?? ""),
    likes: item.like_count ?? 0,
    replies: item.child_comment_count ?? item.child_comments?.length ?? 0,
    created: zhihuCreated(item.created_time),
    reply_to: item.reply_to_author?.name ?? "",
  };
}

export function extractZhihuCommentRows(
  response: unknown,
): Array<Record<string, unknown>> {
  const data = (response as ZhihuCommentResponse).data;
  if (!Array.isArray(data)) {
    throw new Error("Unexpected Zhihu comments response");
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const root of data) {
    const rootRow = zhihuCommentToRow(root);
    rows.push(rootRow);
    const rootId = String(rootRow.id ?? "");
    for (const child of root.child_comments ?? []) {
      rows.push(zhihuCommentToRow(child, rootId));
    }
  }
  return rows;
}

async function zhihuHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
    Referer: "https://www.zhihu.com/",
  };
  const cookies = await loadCookiesWithCDP("zhihu", "www.zhihu.com");
  if (cookies) headers.Cookie = formatCookieHeader(cookies);
  return headers;
}

async function fetchZhihuJson(
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Zhihu comments request failed: ${response.status}`);
  }
  return response.json();
}

cli({
  site: "zhihu",
  name: "comment",
  description: "Get Zhihu comments with normalized nested reply hierarchy",
  domain: "www.zhihu.com",
  strategy: Strategy.COOKIE,
  args: [
    {
      name: "type",
      required: true,
      positional: true,
      description: "Content type: answer or article",
      choices: ["answer", "article"],
    },
    {
      name: "id",
      required: true,
      positional: true,
      description: "Answer or article ID",
      "x-unicli-kind": "id",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of root comments",
    },
    {
      name: "with-replies",
      type: "bool",
      default: false,
      description:
        "Fetch child replies for root comments that omit child_comments",
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
    "content",
    "reply_to",
  ],
  socialCapabilities: ["read", "comments", "comment_replies"],
  func: async (_page, kwargs) => {
    const type = String(kwargs.type);
    const id = String(kwargs.id);
    const limit = Number(kwargs.limit ?? 20);
    const withReplies = Boolean(kwargs["with-replies"]);
    const headers = await zhihuHeaders();
    const rootUrl = `https://www.zhihu.com/api/v4/comment_v5/${encodeURIComponent(type)}s/${encodeURIComponent(id)}/root_comment?limit=${encodeURIComponent(String(limit))}&offset=0&order_by=score`;
    const rootJson = await fetchZhihuJson(rootUrl, headers);
    const rows = extractZhihuCommentRows(rootJson);

    if (withReplies) {
      const roots = (rootJson as ZhihuCommentResponse).data ?? [];
      for (const root of roots) {
        const rootId = root.id === undefined ? "" : String(root.id);
        if (!rootId || (root.child_comments?.length ?? 0) > 0) continue;
        if ((root.child_comment_count ?? 0) <= 0) continue;
        const childUrl = `https://www.zhihu.com/api/v4/comment_v5/comment/${encodeURIComponent(rootId)}/child_comment?limit=20&offset=0&order_by=score`;
        const childJson = await fetchZhihuJson(childUrl, headers);
        for (const child of (childJson as ZhihuCommentResponse).data ?? []) {
          rows.push(zhihuCommentToRow(child, rootId));
        }
      }
    }

    return normalizeCommentRows(rows, {
      platform: "zhihu",
      contentId: `${type}:${id}`,
    });
  },
});
