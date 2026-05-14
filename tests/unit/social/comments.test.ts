import { describe, expect, it } from "vitest";

import { normalizeCommentRows } from "../../../src/social/comments.js";

describe("social comment normalization", () => {
  it("adds stable hierarchy fields while preserving platform aliases", () => {
    const rows = normalizeCommentRows(
      [
        {
          id: "root-a",
          author: "Ada",
          text: "Root",
          likes: 5,
          replies: 1,
          created: "100",
        },
        {
          id: "reply-a",
          parent_id: "root-a",
          author: "Bob",
          content: "Reply",
          like_count: 2,
        },
      ],
      { platform: "unit", contentId: "post-1" },
    );

    expect(rows).toEqual([
      expect.objectContaining({
        platform: "unit",
        content_id: "post-1",
        comment_id: "root-a",
        parent_id: "",
        depth: 0,
        path: "0001",
        author: "Ada",
        text: "Root",
        likes: 5,
        replies: 1,
        created: "100",
      }),
      expect.objectContaining({
        comment_id: "reply-a",
        parent_id: "root-a",
        depth: 1,
        path: "0001.0001",
        author: "Bob",
        text: "Reply",
        likes: 2,
      }),
    ]);
  });

  it("assigns deterministic ids when source rows do not provide ids", () => {
    const rows = normalizeCommentRows(
      [
        { user: "A", body: "First" },
        { user: "B", body: "Second", is_reply: true, reply_to: "A" },
      ],
      { platform: "reddit", contentId: "abc" },
    );

    expect(rows.map((row) => row.comment_id)).toEqual([
      "reddit:abc:1",
      "reddit:abc:2",
    ]);
    expect(rows[1]).toMatchObject({ parent_id: "reddit:abc:1", depth: 1 });
  });
});
