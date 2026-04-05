/**
 * Douyin user-videos — fetch a user's video list with optional top comments.
 *
 * Uses the public Douyin API via browser context for cookie-based auth.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import {
  fetchDouyinUserVideos,
  fetchDouyinComments,
  type DouyinVideo,
} from "./_shared/public-api.js";

const MAX_USER_VIDEOS_LIMIT = 20;
const USER_VIDEO_COMMENT_CONCURRENCY = 4;
const DEFAULT_COMMENT_LIMIT = 10;

function normalizeUserVideosLimit(limit: unknown): number {
  const numeric = Number(limit);
  if (!Number.isFinite(numeric)) return MAX_USER_VIDEOS_LIMIT;
  return Math.min(MAX_USER_VIDEOS_LIMIT, Math.max(1, Math.round(numeric)));
}

function normalizeCommentLimit(limit: unknown): number {
  const numeric = Number(limit);
  if (!Number.isFinite(numeric)) return DEFAULT_COMMENT_LIMIT;
  return Math.min(DEFAULT_COMMENT_LIMIT, Math.max(1, Math.round(numeric)));
}

async function mapInBatches<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += concurrency) {
    const chunk = items.slice(index, index + concurrency);
    results.push(...(await Promise.all(chunk.map(mapper))));
  }
  return results;
}

type EnrichedDouyinVideo = DouyinVideo & {
  top_comments?: Array<{
    text: string;
    digg_count: number;
    nickname: string;
  }>;
};

cli({
  site: "douyin",
  name: "user-videos",
  description: "Get a user's video list with download URLs and top comments",
  domain: "www.douyin.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "sec_uid",
      required: true,
      positional: true,
      description: "User sec_uid (from profile URL)",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of videos (max 20)",
    },
    {
      name: "with_comments",
      type: "bool",
      default: true,
      description: "Include top comments",
    },
    {
      name: "comment_limit",
      type: "int",
      default: 10,
      description: "Comments per video (max 10)",
    },
  ],
  columns: [
    "index",
    "aweme_id",
    "title",
    "duration",
    "digg_count",
    "play_url",
    "top_comments",
  ],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const secUid = String(kwargs.sec_uid);
    const limit = normalizeUserVideosLimit(kwargs.limit);
    const withComments = kwargs.with_comments !== false;
    const commentLimit = normalizeCommentLimit(kwargs.comment_limit);

    await p.goto(`https://www.douyin.com/user/${secUid}`);
    await p.wait(3);

    const awemeList = (await fetchDouyinUserVideos(p, secUid, limit)).slice(
      0,
      limit,
    );
    const videos: EnrichedDouyinVideo[] = withComments
      ? await mapInBatches(
          awemeList,
          USER_VIDEO_COMMENT_CONCURRENCY,
          async (video) => ({
            ...video,
            top_comments: await fetchDouyinComments(
              p,
              video.aweme_id,
              commentLimit,
            ).catch(() => []),
          }),
        )
      : awemeList.map((video) => ({ ...video, top_comments: [] }));

    return videos.map((video, index) => {
      const playUrl = video.video?.play_addr?.url_list?.[0] ?? "";
      return {
        index: index + 1,
        aweme_id: video.aweme_id,
        title: video.desc ?? "",
        duration: Math.round((video.video?.duration ?? 0) / 1000),
        digg_count: video.statistics?.digg_count ?? 0,
        play_url: playUrl,
        top_comments: video.top_comments ?? [],
      };
    });
  },
});
