/**
 * Bilibili video comments adapter.
 *
 * Two-step: resolve bvid → aid via /x/web-interface/view,
 * then fetch comments via /x/v2/reply/main.
 */

import { cli, Strategy } from "../../registry.js";
import { wbiFetch } from "./wbi.js";
import { loadCookies, formatCookieHeader } from "../../engine/cookies.js";
import { USER_AGENT } from "../../constants.js";

interface ViewResponse {
  data: {
    aid: number;
  };
}

interface CommentItem {
  member: { uname: string };
  content: { message: string };
  like: number;
  rcount: number;
}

interface CommentsResponse {
  data: {
    replies: CommentItem[] | null;
  };
}

/** Fetch video aid from bvid using the view API (not WBI-signed). */
async function resolveAid(bvid: string): Promise<number> {
  const cookies = loadCookies("bilibili");
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
  ],
  columns: ["user", "content", "likes", "replies"],
  func: async (_page, kwargs) => {
    const bvid = String(kwargs.bvid);
    const limit = Number(kwargs.limit) || 20;

    const aid = await resolveAid(bvid);

    const json = (await wbiFetch("https://api.bilibili.com/x/v2/reply/main", {
      oid: String(aid),
      type: "1",
      mode: "3",
      ps: String(limit),
    })) as CommentsResponse;

    return (json.data.replies ?? []).map((item) => ({
      user: item.member.uname,
      content: item.content.message,
      likes: item.like,
      replies: item.rcount,
    }));
  },
});
