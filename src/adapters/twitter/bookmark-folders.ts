/**
 * @owner   src/adapters/twitter/bookmark-folders.ts
 * @does    Register agent-facing Twitter/X bookmark folder listing and folder timeline commands.
 * @needs   Twitter cookie auth with ct0/auth_token available to the shared GraphQL client.
 * @feeds   surface coverage ledger and bookmark folder analysis workflows.
 * @breaks  X GraphQL query ID rotation, bookmark collection response shape drift, or Premium folder access changes.
 */

import { cli, Strategy } from "../../registry.js";
import { twitterFetch } from "./client.js";

const FOLDERS_ENDPOINT = "bookmarkFoldersSlice";
const FOLDERS_QUERY_ID = "i78YDd0Tza-dWKw5H2Y7WA";
const FOLDER_TIMELINE_ENDPOINT = "BookmarkFolderTimeline";
const FOLDER_TIMELINE_QUERY_ID = "13H7EUATwethsj_jZ6QQAQ";
const FOLDER_ID_RE = /^[A-Za-z0-9_-]+$/;

const FOLDERS_FEATURES: Record<string, boolean> = {
  rweb_tipjar_consumption_enabled: false,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
};

const FOLDER_TIMELINE_FEATURES: Record<string, boolean> = {
  rweb_video_screen_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  content_disclosure_indicator_enabled: true,
  content_disclosure_ai_generated_indicator_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: false,
  responsive_web_enhance_cards_enabled: false,
};

interface TwitterBookmarkFolderRow {
  id: string;
  name: string;
  items: number;
  created_at: string;
}

interface TwitterBookmarkFolderTweetRow {
  id: string;
  author: string;
  text: string;
  likes: number;
  retweets: number;
  bookmarks: number;
  created_at: string;
  url: string;
}

export function requireTwitterBookmarkFolderId(value: unknown): string {
  const folderId = String(value ?? "").trim();
  if (!folderId || !FOLDER_ID_RE.test(folderId)) {
    throw new Error(
      `Twitter bookmark folder-id must be a safe folder ID from twitter/bookmark-folders.`,
    );
  }
  return folderId;
}

export function requireTwitterBookmarkLimit(
  value: unknown,
  fallback = 20,
): number {
  const limit = Number(value ?? fallback);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(
      "Twitter bookmark-folder limit must be a positive integer.",
    );
  }
  return Math.min(limit, 250);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}

function numberValue(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function parseTwitterBookmarkFolders(
  data: unknown,
): TwitterBookmarkFolderRow[] {
  const seen = new Set<string>();
  const rows: TwitterBookmarkFolderRow[] = [];
  const slice =
    readPath(data, ["data", "viewer", "bookmark_collections_slice"]) ??
    readPath(data, [
      "data",
      "viewer_v2",
      "user_results",
      "result",
      "bookmark_collections_slice",
    ]) ??
    readPath(data, ["data", "bookmark_collections_slice"]);
  const sliceRecord = asRecord(slice);
  const directItems = Array.isArray(sliceRecord?.items)
    ? sliceRecord.items
    : [];
  const instructions = readPath(sliceRecord, [
    "timeline",
    "timeline",
    "instructions",
  ]);
  const timelineItems = Array.isArray(instructions)
    ? instructions.flatMap((instruction) => {
        const entries = asRecord(instruction)?.entries;
        return Array.isArray(entries) ? entries : [];
      })
    : [];
  for (const item of [...directItems, ...timelineItems]) {
    const itemRecord = asRecord(item);
    const content = asRecord(itemRecord?.content);
    const itemContent = asRecord(content?.itemContent);
    const folder =
      asRecord(itemRecord?.bookmarkCollection) ??
      asRecord(content?.bookmarkCollection) ??
      asRecord(itemContent?.bookmark_collection) ??
      itemRecord;
    const id = String(folder?.id_str ?? folder?.id ?? folder?.rest_id ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push({
      id,
      name: String(folder?.name ?? folder?.collection_name ?? ""),
      items: numberValue(
        folder?.bookmarks_count ?? folder?.items_count ?? folder?.count,
      ),
      created_at: String(folder?.created_at ?? folder?.timestamp_ms ?? ""),
    });
  }
  return rows;
}

function extractFolderTweet(
  value: unknown,
  seen: Set<string>,
): TwitterBookmarkFolderTweetRow | null {
  const result = asRecord(value);
  const tweet = asRecord(result?.tweet) ?? result;
  if (!tweet) return null;
  const id = String(tweet.rest_id ?? "");
  if (!id || seen.has(id)) return null;
  seen.add(id);
  const legacy = asRecord(tweet.legacy) ?? {};
  const user =
    asRecord(readPath(tweet, ["core", "user_results", "result"])) ?? {};
  const userLegacy = asRecord(user.legacy) ?? {};
  const userCore = asRecord(user.core) ?? {};
  const author = String(userLegacy.screen_name ?? userCore.screen_name ?? "");
  const noteText = readPath(tweet, [
    "note_tweet",
    "note_tweet_results",
    "result",
    "text",
  ]);
  return {
    id,
    author,
    text: String(noteText ?? legacy.full_text ?? ""),
    likes: numberValue(legacy.favorite_count),
    retweets: numberValue(legacy.retweet_count),
    bookmarks: numberValue(legacy.bookmark_count),
    created_at: String(legacy.created_at ?? ""),
    url: author
      ? `https://x.com/${author}/status/${id}`
      : `https://x.com/i/status/${id}`,
  };
}

export function parseTwitterBookmarkFolderTimeline(data: unknown): {
  tweets: TwitterBookmarkFolderTweetRow[];
  nextCursor: string | null;
} {
  const seen = new Set<string>();
  const tweets: TwitterBookmarkFolderTweetRow[] = [];
  let nextCursor: string | null = null;
  const instructions =
    readPath(data, [
      "data",
      "bookmark_collection_timeline",
      "timeline",
      "instructions",
    ]) ??
    readPath(data, [
      "data",
      "bookmark_timeline_v2",
      "timeline",
      "instructions",
    ]) ??
    readPath(data, ["data", "bookmark_timeline", "timeline", "instructions"]);
  const items = Array.isArray(instructions) ? instructions : [];
  for (const instruction of items) {
    const entries = asRecord(instruction)?.entries;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const entryRecord = asRecord(entry);
      const content = asRecord(entryRecord?.content);
      const entryId = String(entryRecord?.entryId ?? "");
      if (
        content?.entryType === "TimelineTimelineCursor" ||
        content?.__typename === "TimelineTimelineCursor"
      ) {
        if (
          content.cursorType === "Bottom" ||
          content.cursorType === "ShowMore"
        ) {
          nextCursor = String(content.value ?? "") || nextCursor;
        }
        continue;
      }
      if (
        entryId.startsWith("cursor-bottom-") ||
        entryId.startsWith("cursor-showMore-")
      ) {
        const itemContent = asRecord(content?.itemContent);
        nextCursor =
          String(content?.value ?? itemContent?.value ?? "") || nextCursor;
        continue;
      }
      const direct = extractFolderTweet(
        readPath(content, ["itemContent", "tweet_results", "result"]),
        seen,
      );
      if (direct) {
        tweets.push(direct);
        continue;
      }
      const nestedItems = Array.isArray(content?.items) ? content.items : [];
      for (const item of nestedItems) {
        const nested = extractFolderTweet(
          readPath(item, ["item", "itemContent", "tweet_results", "result"]),
          seen,
        );
        if (nested) tweets.push(nested);
      }
    }
  }
  return { tweets, nextCursor };
}

export function applyTwitterTopByEngagement(
  rows: TwitterBookmarkFolderTweetRow[],
  value: unknown,
): TwitterBookmarkFolderTweetRow[] {
  const top = Number(value ?? 0);
  if (!Number.isInteger(top) || top <= 0) return rows;
  return [...rows]
    .sort((a, b) => {
      const scoreA = a.likes + a.retweets * 3 + a.bookmarks * 5;
      const scoreB = b.likes + b.retweets * 3 + b.bookmarks * 5;
      return scoreB - scoreA;
    })
    .slice(0, top);
}

cli({
  site: "twitter",
  name: "bookmark-folders",
  description: "List Twitter/X bookmark folders",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  args: [],
  columns: ["id", "name", "items", "created_at"],
  func: async () => {
    const data = await twitterFetch(
      FOLDERS_ENDPOINT,
      FOLDERS_QUERY_ID,
      {},
      FOLDERS_FEATURES,
    );
    return parseTwitterBookmarkFolders(data);
  },
});

cli({
  site: "twitter",
  name: "bookmark-folder",
  description: "Read tweets inside a Twitter/X bookmark folder",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "folder-id", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
    { name: "top-by-engagement", type: "int", default: 0 },
  ],
  columns: [
    "id",
    "author",
    "text",
    "likes",
    "retweets",
    "bookmarks",
    "created_at",
    "url",
  ],
  func: async (_page, kwargs) => {
    const folderId = requireTwitterBookmarkFolderId(kwargs["folder-id"]);
    const limit = requireTwitterBookmarkLimit(kwargs.limit);
    const rows: TwitterBookmarkFolderTweetRow[] = [];
    let cursor = "";
    for (
      let pageIndex = 0;
      pageIndex < 5 && rows.length < limit;
      pageIndex += 1
    ) {
      const variables: Record<string, unknown> = {
        bookmark_collection_id: folderId,
        count: Math.min(100, limit - rows.length + 10),
        includePromotedContent: false,
      };
      if (cursor) variables.cursor = cursor;
      const data = await twitterFetch(
        FOLDER_TIMELINE_ENDPOINT,
        FOLDER_TIMELINE_QUERY_ID,
        variables,
        FOLDER_TIMELINE_FEATURES,
      );
      const parsed = parseTwitterBookmarkFolderTimeline(data);
      rows.push(...parsed.tweets);
      if (!parsed.nextCursor || parsed.nextCursor === cursor) break;
      cursor = parsed.nextCursor;
    }
    return applyTwitterTopByEngagement(
      rows.slice(0, limit),
      kwargs["top-by-engagement"],
    );
  },
});
