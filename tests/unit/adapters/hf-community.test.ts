import { describe, expect, it } from "vitest";

import { mapHfCommunityRows } from "../../../src/adapters/hf/community.js";

describe("Hugging Face community normalization", () => {
  it("joins posts to topics and emits stable source evidence", () => {
    const rows = mapHfCommunityRows(
      {
        topics: [
          {
            id: 42,
            title: "ROCm inference",
            slug: "rocm-inference",
            posts_count: 8,
            reply_count: 7,
            views: 120,
            last_posted_at: "2026-07-16T10:00:00Z",
          },
        ],
        posts: [
          {
            id: 9,
            topic_id: 42,
            post_number: 3,
            username: "maintainer",
            created_at: "2026-07-15T10:00:00Z",
            like_count: 4,
            blurb: "<b>ROCm</b> support <script>noise()</script>works",
          },
        ],
      },
      10,
    );

    expect(rows).toEqual([
      expect.objectContaining({
        title: "ROCm inference",
        author: "maintainer",
        likes: 4,
        replies: 7,
        views: 120,
        url: "https://discuss.huggingface.co/t/rocm-inference/42/3",
        summary: "**ROCm** support works",
      }),
    ]);
  });
});
