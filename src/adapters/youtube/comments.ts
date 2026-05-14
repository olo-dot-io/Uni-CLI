/**
 * YouTube comments — retrieve top-level comments for a video.
 *
 * Uses InnerTube "next" endpoint which returns engagement panels
 * including the comment section.
 */

import { cli, Strategy } from "../../registry.js";
import { normalizeCommentRows } from "../../social/comments.js";
import { innertubeFetch } from "./innertube.js";

interface CommentRenderer {
  commentRenderer?: {
    commentId?: string;
    authorText?: { simpleText?: string };
    contentText?: { runs?: Array<{ text: string }> };
    voteCount?: { simpleText?: string };
    replyCount?: number;
    publishedTimeText?: { runs?: Array<{ text: string }>; simpleText?: string };
  };
}

interface ReplyContinuationItem {
  commentRenderer?: CommentRenderer["commentRenderer"];
  continuationItemRenderer?: {
    continuationEndpoint?: {
      continuationCommand?: {
        token?: string;
      };
    };
  };
}

interface CommentSection {
  itemSectionRenderer?: {
    contents?: Array<{
      commentThreadRenderer?: {
        comment?: CommentRenderer;
        replies?: {
          commentRepliesRenderer?: {
            contents?: ReplyContinuationItem[];
          };
        };
      };
    }>;
  };
}

interface NextEndpoint {
  reloadContinuationItemsCommand?: {
    continuationItems?: CommentSection[];
  };
  appendContinuationItemsAction?: {
    continuationItems?: CommentSection[];
  };
}

interface NextResponse {
  onResponseReceivedEndpoints?: NextEndpoint[];
  microformat?: {
    microformatDataRenderer?: {
      videoDetails?: {
        comments?: Array<{
          text?: string;
          dateCreated?: string;
          upvoteCount?: string | number;
          author?: {
            name?: string;
            alternateName?: string;
          };
        }>;
      };
    };
  };
}

function rowFromComment(
  c: NonNullable<CommentRenderer["commentRenderer"]>,
  parentId = "",
): Record<string, unknown> {
  return {
    id: c.commentId ?? "",
    parent_id: parentId,
    author: c.authorText?.simpleText ?? "",
    text: c.contentText?.runs?.map((r) => r.text).join("") ?? "",
    likes: c.voteCount?.simpleText ?? "0",
    replies: c.replyCount ?? 0,
    created:
      c.publishedTimeText?.simpleText ??
      c.publishedTimeText?.runs?.map((r) => r.text).join("") ??
      "",
  };
}

function extractReplyRows(
  items: ReplyContinuationItem[],
  parentId: string,
): {
  rows: Array<Record<string, unknown>>;
  continuationTokens: string[];
} {
  const rows: Array<Record<string, unknown>> = [];
  const continuationTokens: string[] = [];
  for (const item of items) {
    if (item.commentRenderer) {
      rows.push(rowFromComment(item.commentRenderer, parentId));
    }
    const token =
      item.continuationItemRenderer?.continuationEndpoint?.continuationCommand
        ?.token;
    if (token) continuationTokens.push(token);
  }
  return { rows, continuationTokens };
}

export function extractYouTubeCommentRows(data: NextResponse): {
  rows: Array<Record<string, unknown>>;
  replyContinuationTokens: Array<{ parentId: string; token: string }>;
} {
  const endpoints = data.onResponseReceivedEndpoints ?? [];
  const rows: Array<Record<string, unknown>> = [];
  const replyContinuationTokens: Array<{ parentId: string; token: string }> =
    [];

  for (const ep of endpoints) {
    const items =
      ep.reloadContinuationItemsCommand?.continuationItems ??
      ep.appendContinuationItemsAction?.continuationItems ??
      [];

    for (const section of items) {
      const contents = section.itemSectionRenderer?.contents ?? [];
      for (const thread of contents) {
        const renderer = thread.commentThreadRenderer;
        const c = renderer?.comment?.commentRenderer;
        if (!c) continue;
        const rootRow = rowFromComment(c);
        const parentId = String(rootRow.id ?? "");
        rows.push(rootRow);
        const replies = renderer?.replies?.commentRepliesRenderer?.contents;
        if (!replies || !parentId) continue;
        const extracted = extractReplyRows(replies, parentId);
        rows.push(...extracted.rows);
        for (const token of extracted.continuationTokens) {
          replyContinuationTokens.push({ parentId, token });
        }
      }
    }
  }

  if (rows.length === 0) {
    const comments =
      data.microformat?.microformatDataRenderer?.videoDetails?.comments ?? [];
    for (const [index, comment] of comments.entries()) {
      rows.push({
        id: `microformat:${index + 1}`,
        author: comment.author?.alternateName ?? comment.author?.name ?? "",
        text: comment.text ?? "",
        likes:
          typeof comment.upvoteCount === "number"
            ? comment.upvoteCount
            : Number(comment.upvoteCount ?? 0),
        replies: 0,
        created: comment.dateCreated ?? "",
      });
    }
  }

  return { rows, replyContinuationTokens };
}

function extractContinuationReplyRows(
  data: NextResponse,
  parentId: string,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const ep of data.onResponseReceivedEndpoints ?? []) {
    const items =
      ep.reloadContinuationItemsCommand?.continuationItems ??
      ep.appendContinuationItemsAction?.continuationItems ??
      [];
    for (const item of items as unknown[]) {
      const renderer = (item as ReplyContinuationItem).commentRenderer;
      if (renderer) rows.push(rowFromComment(renderer, parentId));
    }
  }
  return rows;
}

cli({
  site: "youtube",
  name: "comments",
  description: "Get YouTube video comments",
  domain: "www.youtube.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "videoId",
      type: "str",
      required: true,
      positional: true,
      description: "YouTube video ID",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Max comments to return",
    },
    {
      name: "with-replies",
      type: "bool",
      default: false,
      description: "Fetch available nested replies",
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
  ],
  async func(_page, kwargs) {
    const videoId = kwargs.videoId as string;
    const limit = (kwargs.limit as number) ?? 20;
    const withReplies = Boolean(kwargs["with-replies"]);

    const data = (await innertubeFetch("next", { videoId })) as NextResponse;
    const extracted = extractYouTubeCommentRows(data);
    const rows = extracted.rows.slice(0, limit);

    if (withReplies) {
      for (const continuation of extracted.replyContinuationTokens) {
        const replyData = (await innertubeFetch("next", {
          continuation: continuation.token,
        })) as NextResponse;
        rows.push(
          ...extractContinuationReplyRows(replyData, continuation.parentId),
        );
      }
    }

    return normalizeCommentRows(rows, {
      platform: "youtube",
      contentId: videoId,
    });
  },
});
