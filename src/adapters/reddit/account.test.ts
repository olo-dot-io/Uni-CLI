import { describe, expect, it } from "vitest";
import {
  normalizeRedditCommentFullname,
  parseRedditHomeLimit,
  parseSubredditName,
  requireReplyText,
} from "./account.js";

describe("reddit account and thread helpers", () => {
  it("validates home feed limits", () => {
    expect(parseRedditHomeLimit(undefined)).toBe(25);
    expect(parseRedditHomeLimit("7")).toBe(7);
    expect(() => parseRedditHomeLimit("0")).toThrow("limit must be an integer");
    expect(() => parseRedditHomeLimit("101")).toThrow(
      "limit must be an integer",
    );
    expect(() => parseRedditHomeLimit("1.5")).toThrow(
      "limit must be an integer",
    );
  });

  it("normalizes subreddit names", () => {
    expect(parseSubredditName("python")).toBe("python");
    expect(parseSubredditName("r/MachineLearning")).toBe("MachineLearning");
    expect(parseSubredditName("/r/typescript")).toBe("typescript");
    expect(() => parseSubredditName("")).toThrow("Subreddit name is required");
    expect(() => parseSubredditName("1bad")).toThrow("Invalid subreddit name");
    expect(() => parseSubredditName("ab")).toThrow("Invalid subreddit name");
  });

  it("normalizes Reddit comment targets to t1 fullnames", () => {
    expect(normalizeRedditCommentFullname("okf3s7u")).toBe("t1_okf3s7u");
    expect(normalizeRedditCommentFullname("T1_OKF3S7U")).toBe("t1_okf3s7u");
    expect(
      normalizeRedditCommentFullname(
        "https://www.reddit.com/r/programming/comments/abc123/title/okf3s7u/",
      ),
    ).toBe("t1_okf3s7u");
    expect(() => normalizeRedditCommentFullname("t3_abc123")).toThrow(
      "Comment ID must be a Reddit comment id",
    );
    expect(() =>
      normalizeRedditCommentFullname(
        "https://www.reddit.com/r/programming/comments/abc123/title/okf3s7u/extra",
      ),
    ).toThrow("Comment URL must end at the target comment id");
    expect(() =>
      normalizeRedditCommentFullname("https://example.com/x"),
    ).toThrow("Comment URL must be an https reddit.com URL");
  });

  it("requires non-empty reply text", () => {
    expect(requireReplyText(" hello ")).toBe(" hello ");
    expect(() => requireReplyText("   ")).toThrow("Reply text is required");
  });
});
