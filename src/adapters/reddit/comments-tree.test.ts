import { describe, expect, it } from "vitest";

import { extractRedditCommentRows } from "./comments.js";
import { normalizeCommentRows } from "../../social/comments.js";

describe("reddit comments tree extraction", () => {
  it("preserves nested reply hierarchy from Reddit JSON listings", () => {
    const rawRows = extractRedditCommentRows(
      [
        { data: { children: [] } },
        {
          data: {
            children: [
              {
                kind: "t1",
                data: {
                  id: "root",
                  name: "t1_root",
                  parent_id: "t3_post",
                  author: "alice",
                  body: "root body",
                  score: 10,
                  created_utc: 1,
                  replies: {
                    data: {
                      children: [
                        {
                          kind: "t1",
                          data: {
                            id: "child",
                            name: "t1_child",
                            parent_id: "t1_root",
                            author: "bob",
                            body: "child body",
                            score: 3,
                            created_utc: 2,
                            replies: "",
                          },
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      ],
      "r/test/comments/post/title",
    );

    const rows = normalizeCommentRows(rawRows, {
      platform: "reddit",
      contentId: "r/test/comments/post/title",
    });

    expect(rows).toEqual([
      expect.objectContaining({
        comment_id: "t1_root",
        parent_id: "",
        depth: 0,
        path: "0001",
        author: "alice",
        text: "root body",
        likes: 10,
        replies: 1,
      }),
      expect.objectContaining({
        comment_id: "t1_child",
        parent_id: "t1_root",
        depth: 1,
        path: "0001.0001",
        author: "bob",
        text: "child body",
        likes: 3,
      }),
    ]);
  });
});
