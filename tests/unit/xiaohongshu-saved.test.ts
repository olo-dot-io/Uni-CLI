import { describe, expect, it } from "vitest";
import {
  normalizeXhsSavedRows,
  parseSavedLimit,
} from "../../src/adapters/xiaohongshu/saved.js";

describe("xiaohongshu saved", () => {
  it("normalizes stable saved-note rows and removes duplicates", () => {
    expect(
      normalizeXhsSavedRows(
        [
          {
            id: "abc123",
            title: "  Saved   note ",
            author: "Author",
            likes: "12",
            type: "normal",
            url: "https://www.xiaohongshu.com/explore/abc123?xsec_token=t",
          },
          {
            id: "abc123",
            title: "duplicate",
            url: "https://www.xiaohongshu.com/explore/abc123",
          },
        ],
        20,
      ),
    ).toEqual([
      {
        rank: 1,
        id: "abc123",
        title: "Saved note",
        author: "Author",
        likes: "12",
        type: "normal",
        url: "https://www.xiaohongshu.com/explore/abc123?xsec_token=t",
      },
    ]);
  });

  it("rejects invalid limits instead of silently clamping", () => {
    expect(parseSavedLimit(undefined)).toBe(20);
    expect(parseSavedLimit(100)).toBe(100);
    expect(() => parseSavedLimit(0)).toThrow(/between 1 and 100/);
    expect(() => parseSavedLimit("1.5")).toThrow(/between 1 and 100/);
  });
});
