import { describe, expect, it } from "vitest";
import { resolveCommand } from "../../registry.js";
import {
  applyTwitterTopByEngagement,
  parseTwitterBookmarkFolderTimeline,
  parseTwitterBookmarkFolders,
  requireTwitterBookmarkFolderId,
  requireTwitterBookmarkLimit,
} from "./bookmark-folders.js";

describe("twitter bookmark folder agent-facing commands", () => {
  it("registers both bookmark folder commands", () => {
    expect(
      resolveCommand("twitter", "bookmark-folders")?.command.columns,
    ).toEqual(["id", "name", "items", "created_at"]);
    expect(
      resolveCommand("twitter", "bookmark-folder")?.command.columns,
    ).toEqual([
      "id",
      "author",
      "text",
      "likes",
      "retweets",
      "bookmarks",
      "created_at",
      "url",
    ]);
  });

  it("validates folder ids and limits", () => {
    expect(requireTwitterBookmarkFolderId("abc_123-DEF")).toBe("abc_123-DEF");
    expect(() => requireTwitterBookmarkFolderId("bad/id")).toThrow("folder-id");
    expect(requireTwitterBookmarkLimit(undefined)).toBe(20);
    expect(requireTwitterBookmarkLimit(999)).toBe(250);
    expect(() => requireTwitterBookmarkLimit(0)).toThrow("positive integer");
  });

  it("parses direct bookmark folder rows", () => {
    expect(
      parseTwitterBookmarkFolders({
        data: {
          viewer: {
            bookmark_collections_slice: {
              items: [
                {
                  id_str: "f1",
                  name: "Research",
                  bookmarks_count: 12,
                  created_at: "Tue May 12 00:00:00 +0000 2026",
                },
              ],
            },
          },
        },
      }),
    ).toEqual([
      {
        id: "f1",
        name: "Research",
        items: 12,
        created_at: "Tue May 12 00:00:00 +0000 2026",
      },
    ]);
  });

  it("parses folder timeline tweets and cursors", () => {
    const result = parseTwitterBookmarkFolderTimeline({
      data: {
        bookmark_collection_timeline: {
          timeline: {
            instructions: [
              {
                entries: [
                  {
                    entryId: "tweet-1",
                    content: {
                      itemContent: {
                        tweet_results: {
                          result: {
                            rest_id: "1",
                            core: {
                              user_results: {
                                result: { legacy: { screen_name: "alice" } },
                              },
                            },
                            legacy: {
                              full_text: "hello",
                              favorite_count: 2,
                              retweet_count: 3,
                              bookmark_count: 4,
                              created_at: "date",
                            },
                          },
                        },
                      },
                    },
                  },
                  {
                    entryId: "cursor-bottom-1",
                    content: { value: "cursor-next" },
                  },
                ],
              },
            ],
          },
        },
      },
    });
    expect(result.nextCursor).toBe("cursor-next");
    expect(result.tweets).toEqual([
      {
        id: "1",
        author: "alice",
        text: "hello",
        likes: 2,
        retweets: 3,
        bookmarks: 4,
        created_at: "date",
        url: "https://x.com/alice/status/1",
      },
    ]);
  });

  it("can re-rank bookmark folder rows by engagement", () => {
    expect(
      applyTwitterTopByEngagement(
        [
          {
            id: "low",
            author: "",
            text: "",
            likes: 1,
            retweets: 0,
            bookmarks: 0,
            created_at: "",
            url: "",
          },
          {
            id: "high",
            author: "",
            text: "",
            likes: 0,
            retweets: 0,
            bookmarks: 2,
            created_at: "",
            url: "",
          },
        ],
        1,
      ),
    ).toEqual([
      {
        id: "high",
        author: "",
        text: "",
        likes: 0,
        retweets: 0,
        bookmarks: 2,
        created_at: "",
        url: "",
      },
    ]);
  });
});
