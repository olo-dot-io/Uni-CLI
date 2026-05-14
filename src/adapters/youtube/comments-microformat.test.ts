import { describe, expect, it } from "vitest";

import { extractYouTubeCommentRows } from "./comments.js";

describe("youtube microformat comments fallback", () => {
  it("extracts public schema comments when thread renderers are absent", () => {
    const extracted = extractYouTubeCommentRows({
      microformat: {
        microformatDataRenderer: {
          videoDetails: {
            comments: [
              {
                text: "Public comment",
                dateCreated: "2026-05-14T00:00:00Z",
                upvoteCount: "42",
                author: { alternateName: "@alice", name: "Alice" },
              },
            ],
          },
        },
      },
    });

    expect(extracted.rows).toEqual([
      expect.objectContaining({
        id: "microformat:1",
        author: "@alice",
        text: "Public comment",
        likes: 42,
        replies: 0,
        created: "2026-05-14T00:00:00Z",
      }),
    ]);
  });
});
