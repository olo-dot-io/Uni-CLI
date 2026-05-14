import { describe, expect, it } from "vitest";

import {
  AdapterType,
  Strategy,
  type AdapterManifest,
} from "../../../src/types.js";
import {
  buildSocialAudit,
  buildSocialCoverage,
  inferSocialCapabilities,
  SOCIAL_PLATFORM_REQUIREMENTS,
} from "../../../src/social/capabilities.js";

describe("social capability inference", () => {
  it("infers read, comments, nested replies, media, subtitle, and write capabilities", () => {
    const capabilities = inferSocialCapabilities("comments", {
      name: "comments",
      description: "Get comments on a video with nested replies",
      columns: ["author", "text", "replies"],
    });

    expect(capabilities).toEqual(
      expect.arrayContaining(["comments", "comment_replies", "read"]),
    );

    expect(
      inferSocialCapabilities("subtitles", {
        name: "subtitles",
        description: "Extract video subtitles with yt-dlp",
      }),
    ).toEqual(expect.arrayContaining(["media", "subtitles", "read"]));

    expect(
      inferSocialCapabilities("comment", {
        name: "comment",
        description: "Post a comment on a social post",
        strategy: Strategy.COOKIE,
      }),
    ).toEqual(expect.arrayContaining(["write_comment"]));
  });

  it("infers client-grade actions for agent social workflows", () => {
    expect(
      inferSocialCapabilities("retweet", {
        name: "retweet",
        description: "Retweet a specific tweet",
      }),
    ).toEqual(expect.arrayContaining(["shares"]));

    expect(
      inferSocialCapabilities("bookmark", {
        name: "bookmark",
        description: "Bookmark a tweet",
      }),
    ).toEqual(expect.arrayContaining(["saves"]));

    expect(
      inferSocialCapabilities("reply-dm", {
        name: "reply-dm",
        description: "Reply to a DM conversation",
      }),
    ).toEqual(expect.arrayContaining(["messages"]));

    expect(
      inferSocialCapabilities("hide-reply", {
        name: "hide-reply",
        description: "Hide a reply on your tweet",
      }),
    ).toEqual(expect.arrayContaining(["moderation"]));
  });

  it("does not classify a read-only post detail command as posting", () => {
    expect(
      inferSocialCapabilities("post", {
        name: "post",
        description: "Get a public Threads post from its metadata",
        socialCapabilities: ["read", "author", "media"],
      }),
    ).not.toEqual(expect.arrayContaining(["write_post"]));
  });

  it("builds coverage rows for every adapter and highlights named social platforms", () => {
    const adapters: AdapterManifest[] = [
      {
        name: "youtube",
        type: AdapterType.WEB_API,
        commands: {
          search: { name: "search", description: "Search YouTube videos" },
          transcript: { name: "transcript", description: "Get transcript" },
        },
      },
      {
        name: "weather",
        type: AdapterType.WEB_API,
        commands: {
          now: { name: "now", description: "Current weather" },
        },
      },
    ];

    const rows = buildSocialCoverage(adapters, {
      highlightedSites: ["youtube"],
    });

    expect(rows.find((row) => row.site === "youtube")).toMatchObject({
      site: "youtube",
      highlighted: true,
      commands: 2,
    });
    expect(rows.find((row) => row.site === "youtube")?.capabilities).toEqual(
      expect.arrayContaining(["search", "subtitles"]),
    );
    expect(rows.find((row) => row.site === "weather")).toMatchObject({
      highlighted: false,
      commands: 1,
      capabilities: [],
    });
  });

  it("audits required social platform capabilities and reports missing gaps", () => {
    const adapters: AdapterManifest[] = [
      {
        name: "twitter",
        type: AdapterType.WEB_API,
        commands: Object.fromEntries(
          SOCIAL_PLATFORM_REQUIREMENTS.twitter.map((capability) => [
            capability,
            {
              name: capability,
              socialCapabilities: [capability],
            },
          ]),
        ),
      },
      {
        name: "threads",
        type: AdapterType.WEB_API,
        commands: {
          search: { name: "search", description: "Search Threads posts" },
        },
      },
    ];

    const rows = buildSocialAudit(adapters, {
      twitter: SOCIAL_PLATFORM_REQUIREMENTS.twitter,
      threads: SOCIAL_PLATFORM_REQUIREMENTS.threads,
    });

    expect(rows.find((row) => row.site === "twitter")).toMatchObject({
      status: "pass",
      missing: [],
    });
    expect(rows.find((row) => row.site === "threads")).toMatchObject({
      status: "gap",
      missing: expect.arrayContaining(["trends", "author"]),
    });
  });

  it("treats video subtitle extraction as required on major short-video platforms", () => {
    expect(SOCIAL_PLATFORM_REQUIREMENTS.youtube).toContain("subtitles");
    expect(SOCIAL_PLATFORM_REQUIREMENTS.tiktok).toContain("subtitles");
    expect(SOCIAL_PLATFORM_REQUIREMENTS.instagram).toContain("subtitles");
    expect(SOCIAL_PLATFORM_REQUIREMENTS.facebook).toContain("subtitles");
  });
});
