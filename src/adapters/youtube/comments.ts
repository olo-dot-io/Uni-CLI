/**
 * YouTube comments — retrieve top-level comments for a video.
 *
 * Uses InnerTube "next" endpoint which returns engagement panels
 * including the comment section.
 */

import { cli, Strategy } from "../../registry.js";
import { innertubeFetch } from "./innertube.js";

interface CommentRenderer {
  commentRenderer?: {
    authorText?: { simpleText?: string };
    contentText?: { runs?: Array<{ text: string }> };
    voteCount?: { simpleText?: string };
    replyCount?: number;
  };
}

interface CommentSection {
  itemSectionRenderer?: {
    contents?: Array<{
      commentThreadRenderer?: {
        comment?: CommentRenderer;
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
}

function extractComments(data: NextResponse): Array<Record<string, unknown>> {
  const endpoints = data.onResponseReceivedEndpoints ?? [];
  const results: Array<Record<string, unknown>> = [];

  for (const ep of endpoints) {
    const items =
      ep.reloadContinuationItemsCommand?.continuationItems ??
      ep.appendContinuationItemsAction?.continuationItems ??
      [];

    for (const section of items) {
      const contents = section.itemSectionRenderer?.contents ?? [];
      for (const thread of contents) {
        const c = thread.commentThreadRenderer?.comment?.commentRenderer;
        if (!c) continue;
        results.push({
          author: c.authorText?.simpleText ?? "",
          text: c.contentText?.runs?.map((r) => r.text).join("") ?? "",
          likes: c.voteCount?.simpleText ?? "0",
          replies: c.replyCount ?? 0,
        });
      }
    }
  }

  return results;
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
  ],
  columns: ["author", "text", "likes", "replies"],
  async func(_page, kwargs) {
    const videoId = kwargs.videoId as string;
    const limit = (kwargs.limit as number) ?? 20;

    const data = (await innertubeFetch("next", { videoId })) as NextResponse;

    return extractComments(data).slice(0, limit);
  },
});
