import { describe, expect, it } from "vitest";

import { normalizeTwitterThreadRows } from "./thread.js";

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
