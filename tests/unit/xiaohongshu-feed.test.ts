import { describe, expect, it } from "vitest";
import type { IPage } from "../../src/types.js";
import { fetchXhsFeedItems } from "../../src/adapters/xiaohongshu/browser-state.js";
import { normalizeXhsFeedRows } from "../../src/adapters/xiaohongshu/feed.js";

describe("fetchXhsFeedItems", () => {
  it("falls back to visible DOM rows when store capture returns empty", async () => {
    let evaluateCount = 0;
    const page = {
      async evaluate() {
        evaluateCount += 1;
        if (evaluateCount === 1) return [];
        return [
          {
            id: "684000000000000001000000",
            note_card: {
              display_title: "LLM thinking notes",
              type: "normal",
              user: { nickname: "researcher" },
              interact_info: { liked_count: "500" },
            },
          },
        ];
      },
    } as unknown as IPage;

    const items = await fetchXhsFeedItems(page);

    expect(items).toHaveLength(1);
    expect(evaluateCount).toBe(2);
  });
});

describe("normalizeXhsFeedRows", () => {
  it("keeps only rows with note id and title", () => {
    const rows = normalizeXhsFeedRows(
      [
        {
          id: "684000000000000001000000",
          note_card: {
            display_title: "LLM thinking notes",
            type: "normal",
            user: { nickname: "researcher" },
            interact_info: { liked_count: "500" },
          },
        },
        {
          id: "",
          note_card: { display_title: "missing id" },
        },
      ],
      5,
    );

    expect(rows).toEqual([
      {
        id: "684000000000000001000000",
        title: "LLM thinking notes",
        author: "researcher",
        likes: "500",
        type: "normal",
        url: "https://www.xiaohongshu.com/explore/684000000000000001000000",
      },
    ]);
  });
});
