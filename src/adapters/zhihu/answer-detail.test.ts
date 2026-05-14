import { describe, expect, it } from "vitest";
import {
  extractQuestionIdFromZhihuUrl,
  mapZhihuAnswerDetail,
  parseMaxContent,
  parseZhihuAnswerTarget,
  stripZhihuAnswerHtml,
} from "./answer-detail.js";

describe("zhihu answer-detail helpers", () => {
  it("parses numeric, URL, and typed answer targets", () => {
    expect(parseZhihuAnswerTarget("1937205528846655537")).toEqual({
      answerId: "1937205528846655537",
      questionId: "",
    });
    expect(
      parseZhihuAnswerTarget(
        "https://www.zhihu.com/question/123456/answer/789012",
      ),
    ).toEqual({ questionId: "123456", answerId: "789012" });
    expect(parseZhihuAnswerTarget("answer:123456:789012")).toEqual({
      questionId: "123456",
      answerId: "789012",
    });
  });

  it("rejects non-Zhihu answer targets", () => {
    expect(() =>
      parseZhihuAnswerTarget("https://example.com/question/1/answer/2"),
    ).toThrow("Zhihu answer target");
    expect(() => parseZhihuAnswerTarget("question:1")).toThrow(
      "Zhihu answer target",
    );
  });

  it("strips answer HTML without collapsing paragraphs", () => {
    expect(
      stripZhihuAnswerHtml(
        "<p>Hello&nbsp;&amp;&nbsp;world</p><blockquote>A<br>B</blockquote>",
      ),
    ).toBe("Hello & world\n\nA\nB");
  });

  it("maps full answer payloads with explicit truncation only", () => {
    const row = mapZhihuAnswerDetail(
      {
        content: "<p>abcdef</p>",
        voteup_count: 7,
        comment_count: 2,
        created_time: 1,
        updated_time: 2,
        author: { name: "Ada" },
        question: { id: 123, title: "Question" },
      },
      { answerId: "456", questionId: "" },
      "",
      parseMaxContent(3),
    );
    expect(row).toMatchObject({
      id: "456",
      author: "Ada",
      votes: 7,
      comments: 2,
      question_id: "123",
      question_title: "Question",
      content: "abc",
    });
  });

  it("extracts question ids from supported Zhihu URLs", () => {
    expect(
      extractQuestionIdFromZhihuUrl(
        "https://www.zhihu.com/question/123/answer/456",
      ),
    ).toBe("123");
    expect(
      extractQuestionIdFromZhihuUrl("https://zhihu.com/question/123"),
    ).toBe("123");
    expect(
      extractQuestionIdFromZhihuUrl("https://example.com/question/123"),
    ).toBe("");
  });
});
