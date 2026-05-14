/**
 * @owner   Social capability discovery layer.
 * @does    Infers reusable social-media capabilities from adapter commands.
 * @needs   Adapter manifests with command names, descriptions, columns, and optional explicit social metadata.
 * @feeds   `unicli social coverage`, docs, MCP discovery, and agent planning surfaces.
 * @breaks  New social command families are invisible until the inference table or explicit metadata covers them.
 */

import type {
  AdapterCommand,
  AdapterManifest,
  SocialCapability,
} from "../types.js";

export type { SocialCapability } from "../types.js";

export interface SocialCoverageOptions {
  highlightedSites?: string[];
}

export interface SocialCoverageRow {
  site: string;
  commands: number;
  capabilities: SocialCapability[];
  highlighted: boolean;
}

export interface SocialAuditRow extends SocialCoverageRow {
  required: SocialCapability[];
  missing: SocialCapability[];
  status: "pass" | "gap";
}

export const SOCIAL_CAPABILITY_ORDER: SocialCapability[] = [
  "read",
  "search",
  "trends",
  "comments",
  "comment_replies",
  "write_comment",
  "write_post",
  "media",
  "download",
  "subtitles",
  "author",
  "user_content",
  "relations",
  "notifications",
  "analytics",
];

export const SOCIAL_PLATFORM_REQUIREMENTS: Record<string, SocialCapability[]> =
  {
    xiaohongshu: [
      "read",
      "search",
      "trends",
      "comments",
      "comment_replies",
      "write_post",
      "media",
      "download",
      "author",
      "user_content",
      "analytics",
    ],
    bilibili: [
      "read",
      "search",
      "trends",
      "comments",
      "comment_replies",
      "media",
      "download",
      "subtitles",
      "author",
      "user_content",
    ],
    youtube: [
      "read",
      "search",
      "trends",
      "comments",
      "comment_replies",
      "media",
      "subtitles",
      "author",
      "user_content",
    ],
    twitter: [
      "read",
      "search",
      "trends",
      "comments",
      "comment_replies",
      "write_comment",
      "write_post",
      "media",
      "download",
      "author",
      "user_content",
      "relations",
      "notifications",
    ],
    reddit: [
      "read",
      "search",
      "trends",
      "comments",
      "comment_replies",
      "write_comment",
      "author",
      "user_content",
      "relations",
    ],
    zhihu: [
      "read",
      "search",
      "trends",
      "comments",
      "comment_replies",
      "write_comment",
      "download",
      "author",
      "user_content",
      "relations",
      "notifications",
    ],
    weixin: ["read", "search", "trends", "write_post", "download", "author"],
    tiktok: [
      "read",
      "search",
      "trends",
      "comments",
      "write_comment",
      "media",
      "author",
      "user_content",
      "relations",
      "notifications",
      "analytics",
    ],
    douyin: [
      "read",
      "search",
      "trends",
      "comments",
      "write_post",
      "media",
      "download",
      "author",
      "user_content",
      "analytics",
    ],
    instagram: [
      "read",
      "search",
      "trends",
      "comments",
      "write_comment",
      "write_post",
      "media",
      "download",
      "author",
      "relations",
      "notifications",
      "analytics",
    ],
    facebook: [
      "read",
      "search",
      "comments",
      "write_post",
      "author",
      "user_content",
      "relations",
      "notifications",
    ],
    threads: ["read", "search", "trends", "author"],
  };

const READ_NAMES = new Set([
  "article",
  "answer",
  "answer-detail",
  "detail",
  "download",
  "episode",
  "item",
  "note",
  "paper",
  "post",
  "question",
  "read",
  "thread",
  "transcript",
  "video",
]);

const SEARCH_NAMES = new Set(["search", "suggest", "tags"]);
const TREND_NAMES = new Set([
  "explore",
  "hot",
  "popular",
  "ranking",
  "reels-trending",
  "top",
  "trending",
]);
const AUTHOR_NAMES = new Set([
  "channel",
  "creator-profile",
  "me",
  "profile",
  "user",
]);
const USER_CONTENT_NAMES = new Set([
  "articles",
  "creator-notes",
  "creator-notes-summary",
  "creator-videos",
  "feed",
  "timeline",
  "user-posts",
  "user-videos",
  "videos",
]);
const RELATION_NAMES = new Set([
  "follow",
  "followers",
  "following",
  "friends",
  "subscribe",
  "unfollow",
]);
const NOTIFICATION_NAMES = new Set(["activity", "mentions", "notifications"]);
const ANALYTICS_NAMES = new Set([
  "creator-note-detail",
  "creator-stats",
  "stats",
]);
const WRITE_POST_NAMES = new Set([
  "create-draft",
  "draft",
  "post",
  "publish",
  "reel",
  "story",
]);

function addCapability(
  target: Set<SocialCapability>,
  capability: SocialCapability,
): void {
  target.add(capability);
  if (
    capability !== "write_comment" &&
    capability !== "write_post" &&
    capability !== "relations"
  ) {
    target.add("read");
  }
}

function normalizedText(commandName: string, command: AdapterCommand): string {
  return [
    commandName,
    command.name,
    command.description ?? "",
    ...(command.columns ?? []),
  ]
    .join(" ")
    .toLowerCase();
}

export function inferSocialCapabilities(
  commandName: string,
  command: AdapterCommand,
): SocialCapability[] {
  const capabilities = new Set<SocialCapability>(
    command.socialCapabilities ?? [],
  );
  const text = normalizedText(commandName, command);

  if (
    READ_NAMES.has(commandName) ||
    /\b(read|get|list|browse|detail)\b/.test(text)
  ) {
    addCapability(capabilities, "read");
  }
  if (SEARCH_NAMES.has(commandName) || /\b(search|suggest)\b/.test(text)) {
    addCapability(capabilities, "search");
  }
  if (
    TREND_NAMES.has(commandName) ||
    /\b(hot|trend|popular|ranking|explore)\b/.test(text)
  ) {
    addCapability(capabilities, "trends");
  }
  if (/\bcomments?\b/.test(text)) {
    addCapability(capabilities, "comments");
  }
  if (
    capabilities.has("comments") &&
    /\b(reply|replies|nested|child_comment)\b/.test(text)
  ) {
    addCapability(capabilities, "comment_replies");
  }
  if (
    commandName === "comment" ||
    /\b(post a comment|reply to a comment)\b/.test(text)
  ) {
    capabilities.add("write_comment");
  }
  if (
    WRITE_POST_NAMES.has(commandName) ||
    /\b(publish|create draft|upload)\b/.test(text)
  ) {
    capabilities.add("write_post");
  }
  if (/\b(video|image|media|photo|reel|shorts|story)\b/.test(text)) {
    addCapability(capabilities, "media");
  }
  if (commandName === "download" || /\bdownload\b/.test(text)) {
    addCapability(capabilities, "download");
  }
  if (/\b(subtitles?|transcript)\b/.test(text)) {
    addCapability(capabilities, "subtitles");
  }
  if (
    AUTHOR_NAMES.has(commandName) ||
    /\b(author|creator|profile|channel)\b/.test(text)
  ) {
    addCapability(capabilities, "author");
  }
  if (
    USER_CONTENT_NAMES.has(commandName) ||
    /\b(user videos|creator content|timeline|feed)\b/.test(text)
  ) {
    addCapability(capabilities, "user_content");
  }
  if (
    RELATION_NAMES.has(commandName) ||
    /\b(follow|followers|following|friend)\b/.test(text)
  ) {
    capabilities.add("relations");
  }
  if (
    NOTIFICATION_NAMES.has(commandName) ||
    /\b(notification|mention|activity)\b/.test(text)
  ) {
    addCapability(capabilities, "notifications");
  }
  if (
    ANALYTICS_NAMES.has(commandName) ||
    /\b(metric|analytics|stats|views)\b/.test(text)
  ) {
    addCapability(capabilities, "analytics");
  }

  return SOCIAL_CAPABILITY_ORDER.filter((capability) =>
    capabilities.has(capability),
  );
}

export function buildSocialCoverage(
  adapters: AdapterManifest[],
  options: SocialCoverageOptions = {},
): SocialCoverageRow[] {
  const highlighted = new Set(options.highlightedSites ?? []);
  return adapters
    .map((adapter) => {
      const capabilities = new Set<SocialCapability>();
      const commands = Object.entries(adapter.commands);
      for (const [name, command] of commands) {
        for (const capability of inferSocialCapabilities(name, command)) {
          capabilities.add(capability);
        }
      }
      return {
        site: adapter.name,
        commands: commands.length,
        capabilities: SOCIAL_CAPABILITY_ORDER.filter((capability) =>
          capabilities.has(capability),
        ),
        highlighted: highlighted.has(adapter.name),
      };
    })
    .sort((a, b) => a.site.localeCompare(b.site));
}

export function buildSocialAudit(
  adapters: AdapterManifest[],
  requirements: Record<
    string,
    SocialCapability[]
  > = SOCIAL_PLATFORM_REQUIREMENTS,
): SocialAuditRow[] {
  const coverage = buildSocialCoverage(adapters, {
    highlightedSites: Object.keys(requirements),
  });
  return Object.entries(requirements)
    .map(([site, required]) => {
      const row =
        coverage.find((item) => item.site === site) ??
        ({
          site,
          commands: 0,
          capabilities: [],
          highlighted: true,
        } satisfies SocialCoverageRow);
      const missing = required.filter(
        (capability) => !row.capabilities.includes(capability),
      );
      const status: SocialAuditRow["status"] =
        missing.length === 0 ? "pass" : "gap";
      return {
        ...row,
        required,
        missing,
        status,
      };
    })
    .sort((a, b) => a.site.localeCompare(b.site));
}
