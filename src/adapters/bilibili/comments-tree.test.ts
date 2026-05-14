import { describe, expect, it } from "vitest";

import { normalizeCommentRows } from "../../social/comments.js";

describe("bilibili comment tree normalization", () => {
  it("places fetched child replies under their root rpid", () => {
    const rows = normalizeCommentRows(
      [
        {
          id: "100",
          author: "root-user",
          text: "root",
          likes: 10,
          replies: 1,
        },
        {
          id: "101",
          parent_id: "100",
          author: "child-user",
          text: "reply",
          likes: 2,
          replies: 0,
        },
      ],
      { platform: "bilibili", contentId: "BV1xx" },
    );

    expect(rows[0]).toMatchObject({
      comment_id: "100",
      parent_id: "",
      depth: 0,
      path: "0001",
    });
    expect(rows[1]).toMatchObject({
      comment_id: "101",
      parent_id: "100",
      depth: 1,
      path: "0001.0001",
    });
  });
});
