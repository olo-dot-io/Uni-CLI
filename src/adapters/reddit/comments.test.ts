import { describe, expect, it } from "vitest";
import { extractRedditCommentRows } from "./comments.js";

describe("reddit comments", () => {
  it("preserves nested parentage while normalizing the public listing", () => {
    const output = extractRedditCommentRows(
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
                  score: 7,
                  created_utc: 1_760_000_000,
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
                            created_utc: 1_760_000_100,
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
      "r/programming/comments/post",
    );

    expect(output).toHaveLength(2);
    expect(output[0]).toMatchObject({
      id: "t1_root",
      parent_id: "",
      author: "alice",
      body: "root body",
      score: 7,
      replies: 1,
      content_id: "r/programming/comments/post",
    });
    expect(output[1]).toMatchObject({
      id: "t1_child",
      parent_id: "t1_root",
      author: "bob",
      body: "child body",
      score: 3,
      replies: 0,
    });
  });
});
