/**
 * Bilibili video comments adapter.
 *
 * Two-step: resolve bvid → aid via /x/web-interface/view,
 * then fetch comments via /x/v2/reply/main.
 */

import { cli, Strategy } from "../../registry.js";
import { wbiFetch } from "./wbi.js";
import {
  loadCookiesWithCDP,
  formatCookieHeader,
} from "../../engine/cookies.js";
import { USER_AGENT } from "../../constants.js";
import { normalizeCommentRows } from "../../social/comments.js";

interface ViewResponse {
  data: {
    aid: number;
  };
}

interface CommentItem {
  rpid?: number;
  root?: number;
  parent?: number;
  member: { uname: string };
  content: { message: string };
  like: number;
  rcount: number;
  ctime?: number;
}

interface CommentsResponse {
  data: {
    replies: CommentItem[] | null;
  };
}

/** Fetch video aid from bvid using the view API (not WBI-signed). */
async function resolveAid(bvid: string): Promise<number> {
  const cookies = await loadCookiesWithCDP("bilibili", "bilibili.com");
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
    Referer: "https://www.bilibili.com",
  };
  if (cookies) headers["Cookie"] = formatCookieHeader(cookies);

  const resp = await fetch(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    { headers },
  );
  if (!resp.ok) {
    throw new Error(`Failed to resolve bvid ${bvid}: ${resp.status}`);
  }
  const json = (await resp.json()) as ViewResponse;
  return json.data.aid;
}

cli({
  site: "bilibili",
  name: "comments",
  description: "Fetch comments on a Bilibili video",
  domain: "api.bilibili.com",
  strategy: Strategy.COOKIE,
  args: [
    {
      name: "bvid",
      required: true,
      positional: true,
      description: "Video bvid (e.g. BV1xx...)",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of comments",
    },
    {
      name: "with-replies",
      type: "bool",
      default: false,
      description: "Include nested replies for each root comment",
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
    "user",
    "content",
  ],
  func: async (_page, kwargs) => {
    const bvid = String(kwargs.bvid);
    const limit = Number(kwargs.limit) || 20;
    const withReplies = Boolean(kwargs["with-replies"]);

    const aid = await resolveAid(bvid);

    const json = (await wbiFetch("https://api.bilibili.com/x/v2/reply/main", {
      oid: String(aid),
      type: "1",
      mode: "3",
      ps: String(limit),
    })) as CommentsResponse;

    const roots = json.data.replies ?? [];
    const rows = roots.map((item) => ({
      id: item.rpid ? String(item.rpid) : "",
      parent_id:
        item.parent && item.parent > 0
          ? String(item.parent)
          : item.root && item.root > 0
            ? String(item.root)
            : "",
      user: item.member.uname,
      author: item.member.uname,
      content: item.content.message,
      text: item.content.message,
      likes: item.like,
      replies: item.rcount,
      created: item.ctime ? String(item.ctime) : "",
    }));

    if (withReplies) {
      for (const root of roots) {
        if (!root.rpid || root.rcount <= 0) continue;
        const repliesJson = (await wbiFetch(
          "https://api.bilibili.com/x/v2/reply/reply",
          {
            oid: String(aid),
            type: "1",
            root: String(root.rpid),
            ps: "20",
            pn: "1",
          },
        )) as CommentsResponse;
        for (const reply of repliesJson.data.replies ?? []) {
          rows.push({
            id: reply.rpid ? String(reply.rpid) : "",
            parent_id: String(root.rpid),
            user: reply.member.uname,
            author: reply.member.uname,
            content: reply.content.message,
            text: reply.content.message,
            likes: reply.like,
            replies: reply.rcount,
            created: reply.ctime ? String(reply.ctime) : "",
          });
        }
      }
    }

    return normalizeCommentRows(rows, {
      platform: "bilibili",
      contentId: bvid,
    });
  },
});
