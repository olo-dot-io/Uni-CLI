import { describe, expect, it } from "vitest";
import {
  mapZhihuRecommendItem,
  normalizeZhihuRecommendTitle,
  normalizeZhihuRecommendUrl,
  parseZhihuRecommendLimit,
  zhihuRecommendItemKey,
} from "./recommend.js";

describe("zhihu recommend helpers", () => {
  it("validates positive bounded limits", () => {
    expect(parseZhihuRecommendLimit(undefined)).toBe(20);
    expect(parseZhihuRecommendLimit("3")).toBe(3);
    expect(() => parseZhihuRecommendLimit(0)).toThrow("positive integer");
    expect(() => parseZhihuRecommendLimit(1001)).toThrow(
      "no greater than 1000",
    );
  });

  it("normalizes answer recommendation rows", () => {
    const item = {
      id: "feed-1",
      target: {
        id: 456,
        type: "answer",
        question: { id: 123, title: "Why?" },
        author: { name: "Ada" },
        voteup_count: 9,
      },
    };
    expect(zhihuRecommendItemKey(item)).toBe("answer:456");
    expect(normalizeZhihuRecommendTitle(item)).toBe("Why?");
    expect(normalizeZhihuRecommendUrl(item)).toBe(
      "https://www.zhihu.com/question/123/answer/456",
    );
    expect(mapZhihuRecommendItem(item, 1)).toEqual({
      rank: 1,
      type: "answer",
      title: "Why?",
      author: "Ada",
      votes: 9,
      url: "https://www.zhihu.com/question/123/answer/456",
    });
  });

  it("normalizes article and question URLs", () => {
    expect(
      normalizeZhihuRecommendUrl({
        target: { id: 789, type: "article", title: "Article" },
      }),
    ).toBe("https://zhuanlan.zhihu.com/p/789");
    expect(
      normalizeZhihuRecommendUrl({
        target: { id: 123, type: "question", title: "Question" },
      }),
    ).toBe("https://www.zhihu.com/question/123");
  });

  it("uses feed ids as dedupe keys when targets have no id", () => {
    expect(zhihuRecommendItemKey({ id: "feed-only", type: "feed" })).toBe(
      "feed:feed-only",
    );
    expect(zhihuRecommendItemKey({ type: "feed" })).toBe("");
  });
});
