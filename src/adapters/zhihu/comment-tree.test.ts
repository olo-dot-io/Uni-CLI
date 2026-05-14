import { describe, expect, it } from "vitest";

import { normalizeCommentRows } from "../../social/comments.js";
import { extractZhihuCommentRows } from "./comment.js";

describe("zhihu comment tree extraction", () => {
  it("normalizes root comments and child comments", () => {
    const rows = normalizeCommentRows(
      extractZhihuCommentRows({
        data: [
          {
            id: "root",
            author: { name: "Alice" },
            content: "<p>Root</p>",
            like_count: 4,
            child_comment_count: 1,
            created_time: 1,
            child_comments: [
              {
                id: "child",
                author: { name: "Bob" },
                content: "<p>Child</p>",
                like_count: 2,
                created_time: 2,
                reply_to_author: { name: "Alice" },
              },
            ],
          },
        ],
      }),
      { platform: "zhihu", contentId: "answer:123" },
    );

    expect(rows).toEqual([
      expect.objectContaining({
        comment_id: "root",
        parent_id: "",
        depth: 0,
        path: "0001",
        author: "Alice",
        text: "Root",
        likes: 4,
        replies: 1,
      }),
      expect.objectContaining({
        comment_id: "child",
        parent_id: "root",
        depth: 1,
        path: "0001.0001",
        author: "Bob",
        text: "Child",
        likes: 2,
        reply_to: "Alice",
      }),
    ]);
  });
});
