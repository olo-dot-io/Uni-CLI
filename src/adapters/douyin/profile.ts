/**
 * Douyin profile — fetch account info from the creator center API.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { browserFetch } from "./_shared/browser-fetch.js";

cli({
  site: "douyin",
  name: "profile",
  description: "Get Douyin account info",
  domain: "creator.douyin.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [],
  columns: [
    "uid",
    "nickname",
    "follower_count",
    "following_count",
    "aweme_count",
  ],
  func: async (page, _kwargs) => {
    const p = page as IPage;
    const url = "https://creator.douyin.com/web/api/media/user/info/?aid=1128";
    const res = (await browserFetch(p, "GET", url)) as {
      user_info?: {
        uid: string;
        nickname: string;
        follower_count: number;
        following_count: number;
        aweme_count: number;
      };
      user?: {
        uid: string;
        nickname: string;
        follower_count: number;
        following_count: number;
        aweme_count: number;
      };
    };
    const u = res.user_info ?? res.user;
    if (!u)
      throw new Error(
        "Failed to get user info — are you logged into creator.douyin.com?",
      );
    return [
      {
        uid: u.uid,
        nickname: u.nickname,
        follower_count: u.follower_count,
        following_count: u.following_count,
        aweme_count: u.aweme_count,
      },
    ];
  },
});
