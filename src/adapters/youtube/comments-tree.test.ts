import { describe, expect, it } from "vitest";

import { normalizeCommentRows } from "../../social/comments.js";
import { extractYouTubeCommentRows } from "./comments.js";

describe("youtube comment tree extraction", () => {
  it("keeps inline reply rows under their parent comment", () => {
    const extracted = extractYouTubeCommentRows({
      onResponseReceivedEndpoints: [
        {
          appendContinuationItemsAction: {
            continuationItems: [
              {
                itemSectionRenderer: {
                  contents: [
                    {
                      commentThreadRenderer: {
                        comment: {
                          commentRenderer: {
                            commentId: "root",
                            authorText: { simpleText: "Alice" },
                            contentText: { runs: [{ text: "Root" }] },
                            voteCount: { simpleText: "5" },
                            replyCount: 1,
                          },
                        },
                        replies: {
                          commentRepliesRenderer: {
                            contents: [
                              {
                                commentRenderer: {
                                  commentId: "child",
                                  authorText: { simpleText: "Bob" },
                                  contentText: { runs: [{ text: "Child" }] },
                                  voteCount: { simpleText: "2" },
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
          },
        },
      ],
    });

    const rows = normalizeCommentRows(extracted.rows, {
      platform: "youtube",
      contentId: "video",
    });

    expect(rows).toEqual([
      expect.objectContaining({
        comment_id: "root",
        parent_id: "",
        depth: 0,
        path: "0001",
        text: "Root",
      }),
      expect.objectContaining({
        comment_id: "child",
        parent_id: "root",
        depth: 1,
        path: "0001.0001",
        text: "Child",
      }),
    ]);
  });
});
