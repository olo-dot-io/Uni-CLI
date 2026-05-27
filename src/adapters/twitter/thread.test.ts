import { describe, expect, it } from "vitest";
import { resolveCommand } from "../../registry.js";

import {
  normalizeTwitterThreadRows,
  resolveTwitterThreadTweetId,
} from "./thread.js";

describe("normalizeTwitterThreadRows", () => {
  it("adds normalized comment hierarchy fields to thread rows", () => {
    const rows = normalizeTwitterThreadRows("root", [
      {
        id: "root",
        author: "Root",
        text: "Root tweet",
        likes: 10,
        retweets: 2,
        views: "100",
        url: "https://x.com/i/status/root",
      },
      {
        id: "reply-1",
        author: "Reply",
        text: "Reply tweet",
        likes: 1,
        retweets: 0,
        views: "5",
        url: "https://x.com/i/status/reply-1",
      },
    ]);

    expect(rows).toEqual([
      expect.objectContaining({
        id: "root",
        parent_id: "",
        depth: 0,
        path: "0001",
      }),
      expect.objectContaining({
        id: "reply-1",
        parent_id: "root",
        depth: 1,
        path: "0001.0001",
      }),
    ]);
  });
});

describe("twitter thread and comments commands", () => {
  it("accepts either a numeric tweet id or a Twitter/X status URL", () => {
    expect(resolveTwitterThreadTweetId("123")).toBe("123");
    expect(
      resolveTwitterThreadTweetId(
        "https://x.com/alice/status/2040254679301718161?s=20",
      ),
    ).toBe("2040254679301718161");
  });

  it("registers a comments command for tweet replies", () => {
    const comments = resolveCommand("twitter", "comments")?.command;

    expect(comments?.adapterArgs?.map((arg) => arg.name)).toEqual(["url"]);
    expect(comments?.socialCapabilities).toEqual(
      expect.arrayContaining(["comments", "comment_replies"]),
    );
  });
});
