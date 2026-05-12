import { describe, expect, it, vi } from "vitest";
import { resolveCommand } from "../../registry.js";
import {
  buildTikTokItemListRequest,
  extractTikTokUsername,
  normalizeTikTokCreatorVideoRow,
  requireTikTokCursor,
  requireTikTokPositiveInt,
} from "./creator-videos.js";

function pageMock(evaluateResults: unknown[]) {
  const evaluate = vi.fn();
  for (const result of evaluateResults) evaluate.mockResolvedValueOnce(result);
  evaluate.mockResolvedValue({
    ok: true,
    data: { item_list: [], has_more: false },
  });
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate,
  };
}

const apiItem = {
  item_id: "7350000000000000000",
  desc: "hello\nworld",
  create_time: 1710000000,
  play_count: "123",
  like_count: "12",
  comment_count: "3",
  favorite_count: "4",
  share_count: "5",
  author: { uniqueId: "creator" },
};

describe("tiktok creator-videos agent-facing command", () => {
  it("validates limits, cursors, and request bodies", () => {
    expect(requireTikTokPositiveInt(undefined, "limit", 20, 250)).toBe(20);
    expect(requireTikTokPositiveInt("2", "limit", 20, 250)).toBe(2);
    expect(() => requireTikTokPositiveInt(0, "limit", 20, 250)).toThrow(
      "positive integer",
    );
    expect(() => requireTikTokPositiveInt(251, "limit", 20, 250)).toThrow(
      "<= 250",
    );
    expect(requireTikTokCursor(undefined)).toBe(0);
    expect(requireTikTokCursor("42")).toBe(42);
    expect(() => requireTikTokCursor("abc")).toThrow("cursor");
    expect(buildTikTokItemListRequest(4, 10)).toMatchObject({
      cursor: 4,
      size: 10,
      query: { sort_orders: [{ field_name: "create_time", order: 2 }] },
    });
  });

  it("normalizes TikTok Studio API rows", () => {
    expect(normalizeTikTokCreatorVideoRow(apiItem)).toMatchObject({
      video_id: "7350000000000000000",
      title: "hello world",
      views: 123,
      likes: 12,
      comments: 3,
      saves: 4,
      shares: 5,
      url: "https://www.tiktok.com/@creator/video/7350000000000000000",
    });
    expect(normalizeTikTokCreatorVideoRow({ desc: "missing id" })).toBeNull();
    expect(
      extractTikTokUsername({
        play_addr: ["https://example.invalid/video?user_text=test_user&x=1"],
      }),
    ).toBe("test_user");
  });

  it("fetches creator videos from TikTok Studio", async () => {
    const command = resolveCommand("tiktok", "creator-videos")?.command;
    const page = pageMock([
      {
        ok: true,
        data: {
          status_code: 0,
          status_msg: "success",
          item_list: [apiItem],
          has_more: false,
        },
      },
    ]);
    await expect(command!.func!(page, { limit: 1 })).resolves.toEqual([
      expect.objectContaining({
        video_id: "7350000000000000000",
        title: "hello world",
        views: 123,
        likes: 12,
        url: "https://www.tiktok.com/@creator/video/7350000000000000000",
      }),
    ]);
    expect(page.goto).toHaveBeenCalledWith(
      "https://www.tiktok.com/tiktokstudio/content",
      { waitUntil: "load", settleMs: 6000 },
    );
  });

  it("fails before navigation on invalid args", async () => {
    const command = resolveCommand("tiktok", "creator-videos")?.command;
    const page = pageMock([]);
    await expect(command!.func!(page, { limit: 0 })).rejects.toThrow(
      "positive integer",
    );
    await expect(command!.func!(page, { cursor: "abc" })).rejects.toThrow(
      "cursor",
    );
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("classifies auth, API, empty, and missing-id states", async () => {
    const command = resolveCommand("tiktok", "creator-videos")?.command;
    await expect(
      command!.func!(pageMock([{ ok: false, status: 403 }]), { limit: 1 }),
    ).rejects.toThrow("requires login");
    await expect(
      command!.func!(
        pageMock([
          {
            ok: true,
            data: {
              status_code: 1001,
              status_msg: "creator permission denied",
            },
          },
        ]),
        { limit: 1 },
      ),
    ).rejects.toThrow("requires login");
    await expect(
      command!.func!(
        pageMock([
          { ok: true, data: { status_code: 500, status_msg: "fail" } },
        ]),
        { limit: 1 },
      ),
    ).rejects.toThrow("item_list failed");
    await expect(
      command!.func!(
        pageMock([{ ok: true, data: { item_list: [], has_more: false } }]),
        {
          limit: 1,
        },
      ),
    ).rejects.toThrow("No TikTok Studio creator videos");
    await expect(
      command!.func!(
        pageMock([{ ok: true, data: { item_list: [{ desc: "missing" }] } }]),
        { limit: 1 },
      ),
    ).rejects.toThrow("stable video_id");
  });
});
