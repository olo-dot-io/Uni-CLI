import { describe, expect, it } from "vitest";
import { extractZhihuCommentRows } from "./comment.js";

describe("zhihu comment", () => {
  it("flattens root and child comments with stable parent ids", () => {
    const output = extractZhihuCommentRows({
      data: [
        {
          id: 101,
          author: { name: "Alice" },
          content: "<p>root <strong>comment</strong></p>",
          like_count: 9,
          child_comment_count: 1,
          created_time: 1_760_000_000,
          child_comments: [
            {
              id: 102,
              author: { name: "Bob" },
              reply_to_author: { name: "Alice" },
              content: "<p>child reply</p>",
              like_count: 2,
              created_time: 1_760_000_100,
            },
          ],
        },
      ],
    });

    expect(output).toHaveLength(2);
    expect(output[0]).toMatchObject({
      id: "101",
      parent_id: "",
      author: "Alice",
      content: "root comment",
      text: "root comment",
      likes: 9,
      replies: 1,
    });
    expect(output[1]).toMatchObject({
      id: "102",
      parent_id: "101",
      author: "Bob",
      content: "child reply",
      reply_to: "Alice",
      likes: 2,
      replies: 0,
    });
  });
});
