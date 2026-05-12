import { describe, expect, it } from "vitest";
import {
  mapZhihuCollectionItem,
  requireZhihuCollectionId,
  requireZhihuNonNegativeInt,
  requireZhihuPositiveInt,
  stripZhihuHtml,
  zhihuCollectionItemKey,
} from "./collection.js";

describe("zhihu agent-facing collection command", () => {
  it("validates collection ids and pagination args", () => {
    expect(requireZhihuCollectionId(" 83283292 ")).toBe("83283292");
    expect(() => requireZhihuCollectionId("abc")).toThrow("numeric");
    expect(requireZhihuPositiveInt(20, "limit")).toBe(20);
    expect(() => requireZhihuPositiveInt(0, "limit")).toThrow("positive");
    expect(requireZhihuNonNegativeInt(0, "offset")).toBe(0);
    expect(() => requireZhihuNonNegativeInt(-1, "offset")).toThrow(
      "non-negative",
    );
  });

  it("strips Zhihu HTML entities", () => {
    expect(stripZhihuHtml("<p>A&nbsp;&lt;B&gt;&amp;C</p>")).toBe("A <B>&C");
  });

  it("maps answer, article, and pin items to stable columns", () => {
    expect(
      mapZhihuCollectionItem(
        {
          content: {
            type: "answer",
            id: 2,
            content: "<p>Answer body</p>",
            question: { id: 1, title: "Question title" },
            author: { name: "Alice" },
            voteup_count: 42,
          },
        },
        1,
      ),
    ).toEqual({
      rank: 1,
      type: "answer",
      title: "Question title",
      author: "Alice",
      votes: 42,
      excerpt: "Answer body",
      url: "https://www.zhihu.com/question/1/answer/2",
    });

    expect(
      mapZhihuCollectionItem(
        {
          content: {
            type: "article",
            id: 3,
            title: "Article",
            content: "Article body",
            author: { name: "Bob" },
            voteup_count: 7,
          },
        },
        2,
      ).url,
    ).toBe("https://zhuanlan.zhihu.com/p/3");

    expect(
      mapZhihuCollectionItem(
        {
          content: {
            type: "pin",
            id: 4,
            content: [{ content: "Pin body" }],
            author: { name: "Carol" },
            reaction_count: 5,
          },
        },
        3,
      ),
    ).toMatchObject({
      rank: 3,
      type: "pin",
      title: "想法",
      author: "Carol",
      votes: 5,
      excerpt: "Pin body",
    });
  });

  it("creates stable item keys", () => {
    expect(zhihuCollectionItemKey({ content: { type: "answer", id: 2 } })).toBe(
      "answer:2",
    );
  });
});
