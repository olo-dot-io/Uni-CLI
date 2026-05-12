import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveCommand } from "../../registry.js";
import {
  REDNOTE_COMMENT_COLUMNS,
  REDNOTE_DOWNLOAD_COLUMNS,
  REDNOTE_FEED_COLUMNS,
  REDNOTE_NOTE_COLUMNS,
  REDNOTE_NOTIFICATION_COLUMNS,
  REDNOTE_SEARCH_COLUMNS,
  REDNOTE_USER_COLUMNS,
  buildRednoteNoteUrl,
  normalizeRednoteUserId,
  parseRednoteLimit,
  parseRednoteNotificationType,
  parseRednoteNoteId,
  parseRednoteSearchLimit,
  rednoteNoteIdToDate,
} from "./web.js";

function pageMock(evaluateResults: unknown[]) {
  const queue = [...evaluateResults];
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async () => queue.shift()),
    autoScroll: vi.fn().mockResolvedValue(undefined),
    cookies: vi.fn().mockResolvedValue({ sid: "secret" }),
  };
}

describe("rednote agent-facing web commands", () => {
  it("registers the full surface Rednote surface", () => {
    const expected = [
      ["note", REDNOTE_NOTE_COLUMNS],
      ["search", REDNOTE_SEARCH_COLUMNS],
      ["user", REDNOTE_USER_COLUMNS],
      ["comments", REDNOTE_COMMENT_COLUMNS],
      ["feed", REDNOTE_FEED_COLUMNS],
      ["notifications", REDNOTE_NOTIFICATION_COLUMNS],
      ["download", REDNOTE_DOWNLOAD_COLUMNS],
    ];
    for (const [name, columns] of expected) {
      const command = resolveCommand("rednote", String(name))?.command;
      expect(command?.strategy).toBe("cookie");
      expect(command?.browser).toBe(true);
      expect(command?.columns).toEqual(columns);
    }
  });

  it("validates rednote URL identity and limits before browser work", async () => {
    const signed =
      "https://www.rednote.com/search_result/69bc166f000000001a02069a?xsec_token=abc";
    expect(parseRednoteNoteId(signed)).toBe("69bc166f000000001a02069a");
    expect(buildRednoteNoteUrl(signed)).toBe(signed);
    expect(buildRednoteNoteUrl("69bc166f000000001a02069a")).toBe(
      "https://www.rednote.com/explore/69bc166f000000001a02069a",
    );
    expect(
      normalizeRednoteUserId("https://www.rednote.com/user/profile/u123"),
    ).toBe("u123");
    expect(rednoteNoteIdToDate(signed)).toBe("2026-03-19");
    expect(parseRednoteLimit("5", 20)).toBe(5);
    expect(parseRednoteSearchLimit("100")).toBe(100);
    expect(parseRednoteNotificationType("likes")).toBe("likes");
    expect(() =>
      parseRednoteNoteId("https://www.xiaohongshu.com/search_result/abc"),
    ).toThrow("rednote.com");
    expect(() => parseRednoteSearchLimit(101)).toThrow("between 1 and 100");
    expect(() => parseRednoteLimit(0, 20)).toThrow("positive integer");
    expect(() => parseRednoteNotificationType("comments")).toThrow(
      "mentions, likes, or connections",
    );

    const comments = resolveCommand("rednote", "comments")?.command;
    const page = pageMock([]);
    await expect(
      comments!.func!(page, {
        "note-id": signed,
        limit: 0,
      }),
    ).rejects.toThrow("positive integer");
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("maps note rows and keeps note failure states explicit", async () => {
    const note = resolveCommand("rednote", "note")?.command;
    await expect(
      note!.func!(
        pageMock([
          {
            title: " Travel  ",
            author: "Ada",
            desc: "Rednote body",
            likes: "12",
            collects: "3",
            comments: "4",
            tags: ["#tokyo"],
          },
        ]),
        {
          "note-id":
            "https://www.rednote.com/search_result/69bc166f000000001a02069a?xsec_token=abc",
        },
      ),
    ).resolves.toEqual([
      { field: "title", value: "Travel" },
      { field: "author", value: "Ada" },
      { field: "content", value: "Rednote body" },
      { field: "likes", value: "12" },
      { field: "collects", value: "3" },
      { field: "comments", value: "4" },
      { field: "tags", value: "#tokyo" },
    ]);
    await expect(
      note!.func!(pageMock([{ loginWall: true }]), {
        "note-id": "69bc166f000000001a02069a",
      }),
    ).rejects.toThrow("requires login");
    await expect(
      note!.func!(pageMock([{ securityBlock: true }]), {
        "note-id": "69bc166f000000001a02069a",
      }),
    ).rejects.toThrow("security block");
  });

  it("searches rendered notes with Rednote login-wall handling", async () => {
    const search = resolveCommand("rednote", "search")?.command;
    const page = pageMock([
      "content",
      { count: 1, stable: false },
      [
        {
          title: " Guide ",
          author: "Ada",
          likes: "7",
          url: "https://www.rednote.com/search_result/69bc166f000000001a02069a",
          author_url: "https://www.rednote.com/user/profile/u123",
        },
      ],
    ]);
    await expect(
      search!.func!(page, { query: "tokyo", limit: 1 }),
    ).resolves.toEqual([
      {
        rank: 1,
        title: "Guide",
        author: "Ada",
        likes: "7",
        published_at: "2026-03-19",
        url: "https://www.rednote.com/search_result/69bc166f000000001a02069a",
        author_url: "https://www.rednote.com/user/profile/u123",
      },
    ]);
    expect(page.goto).toHaveBeenCalledWith(
      "https://www.rednote.com/search_result?keyword=tokyo&source=web_search_result_notes",
    );
    await expect(
      search!.func!(pageMock(["login_wall"]), { query: "tokyo" }),
    ).rejects.toThrow("login wall");
  });

  it("reads Rednote user notes through the shared user extractor with Rednote host", async () => {
    const user = resolveCommand("rednote", "user")?.command;
    const page = pageMock([
      {
        noteGroups: [
          {
            noteCard: {
              noteId: "69bc166f000000001a02069a",
              displayTitle: "Guide",
              type: "normal",
              interactInfo: { likedCount: 9 },
              user: { userId: "u123" },
            },
            xsecToken: "token",
          },
        ],
      },
    ]);
    await expect(user!.func!(page, { id: "u123", limit: 1 })).resolves.toEqual([
      {
        id: "69bc166f000000001a02069a",
        title: "Guide",
        type: "normal",
        likes: "9",
        cover: "",
        url: "https://www.rednote.com/user/profile/u123/69bc166f000000001a02069a?xsec_token=token&xsec_source=pc_user",
      },
    ]);
  });

  it("reads comments with optional replies and explicit auth failure", async () => {
    const comments = resolveCommand("rednote", "comments")?.command;
    await expect(
      comments!.func!(
        pageMock([
          {
            results: [
              {
                author: "Ada",
                text: "Nice",
                likes: 2,
                time: "today",
                is_reply: false,
                reply_to: "",
              },
              {
                author: "Ben",
                text: "Agree",
                likes: 1,
                time: "today",
                is_reply: true,
                reply_to: "Ada",
              },
            ],
          },
        ]),
        {
          "note-id":
            "https://www.rednote.com/search_result/69bc166f000000001a02069a?xsec_token=abc",
          "with-replies": true,
          limit: 1,
        },
      ),
    ).resolves.toHaveLength(2);
    await expect(
      comments!.func!(pageMock([{ loginWall: true }]), {
        "note-id": "69bc166f000000001a02069a",
      }),
    ).rejects.toThrow("require login");
  });

  it("reads feed and notifications from hydrated Pinia stores", async () => {
    const feed = resolveCommand("rednote", "feed")?.command;
    await expect(
      feed!.func!(
        pageMock([
          {
            items: [
              {
                id: "69bc166f000000001a02069a",
                title: "Guide",
                author: "Ada",
                likes: 4,
                type: "normal",
              },
            ],
          },
        ]),
        { limit: 1 },
      ),
    ).resolves.toEqual([
      {
        id: "69bc166f000000001a02069a",
        title: "Guide",
        author: "Ada",
        likes: "4",
        type: "normal",
        url: "https://www.rednote.com/explore/69bc166f000000001a02069a",
      },
    ]);
    await expect(
      feed!.func!(pageMock([{ error: "no_pinia" }]), {}),
    ).rejects.toThrow("no_pinia");

    const notifications = resolveCommand("rednote", "notifications")?.command;
    await expect(
      notifications!.func!(
        pageMock([
          {
            items: [
              {
                user: "Ada",
                action: "mentioned you",
                content: "hello",
                note: "Guide",
                time: "now",
              },
            ],
          },
        ]),
        { type: "mentions", limit: 1 },
      ),
    ).resolves.toEqual([
      {
        rank: 1,
        user: "Ada",
        action: "mentioned you",
        content: "hello",
        note: "Guide",
        time: "now",
      },
    ]);
    await expect(
      notifications!.func!(
        pageMock([{ error: "action_failed", detail: "boom" }]),
        {
          type: "mentions",
        },
      ),
    ).rejects.toThrow("action_failed (boom)");
    await expect(
      notifications!.func!(pageMock([{ items: [] }]), {
        type: "mentions",
      }),
    ).resolves.toEqual([]);
  });

  it("downloads extracted Rednote media with page cookies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-rednote-"));
    const fetchMock = vi.fn().mockResolvedValue(new Response("image-bytes"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const download = resolveCommand("rednote", "download")?.command;
      await expect(
        download!.func!(
          pageMock([
            {
              media: [
                {
                  type: "image",
                  url: "https://ci.rednote.com/example.jpg?token=abc",
                },
              ],
            },
          ]),
          {
            "note-id":
              "https://www.rednote.com/search_result/69bc166f000000001a02069a?xsec_token=abc",
            output: dir,
          },
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          index: 1,
          type: "image",
          status: "success",
          size: 11,
          error: "",
        }),
      ]);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://ci.rednote.com/example.jpg?token=abc",
        { headers: { Cookie: "sid=secret" } },
      );
    } finally {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
