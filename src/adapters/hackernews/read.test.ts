import { describe, expect, it } from "vitest";
import {
  buildHnReadRows,
  hnHtmlToText,
  requireHnItemId,
  requireMinInt,
  requirePositiveInt,
} from "./read.js";

describe("hackernews agent-facing read command", () => {
  it("validates item ids, positive ints, and HTML text conversion", () => {
    expect(requireHnItemId(" 39847301 ")).toBe("39847301");
    expect(() => requireHnItemId("abc")).toThrow("Invalid HN");
    expect(requirePositiveInt(undefined, 25, "limit")).toBe(25);
    expect(() => requirePositiveInt("0", 25, "limit")).toThrow("positive");
    expect(requireMinInt(undefined, 2000, 100, "max")).toBe(2000);
    expect(() => requireMinInt("99", 2000, 100, "max")).toThrow(">= 100");
    expect(
      hnHtmlToText(
        '<p>Hello &amp; <i>world</i><p><a href="https://x.test">link</a>',
      ),
    ).toBe("Hello & world\n\nlink (https://x.test)");
  });

  it("builds story and bounded comment tree rows", async () => {
    const fixtures = new Map([
      [
        2,
        {
          id: 2,
          type: "comment",
          by: "alice",
          text: "First",
          kids: [4, 5],
        },
      ],
      [3, { id: 3, type: "comment", by: "bob", text: "Second" }],
      [4, { id: 4, type: "comment", by: "carol", text: "Reply" }],
      [5, { id: 5, type: "comment", by: "dan", text: "Hidden" }],
    ]);
    const rows = await buildHnReadRows(
      {
        id: 1,
        type: "story",
        by: "pg",
        title: "Launch",
        url: "https://example.test",
        score: 42,
        kids: [2, 3, 99],
      },
      async (id) => fixtures.get(id) ?? null,
      { limit: 2, maxDepth: 2, maxReplies: 1, maxLength: 100 },
    );
    expect(rows).toEqual([
      {
        type: "POST",
        author: "pg",
        score: 42,
        text: "Launch\nhttps://example.test",
      },
      { type: "L0", author: "alice", score: "", text: "First" },
      { type: "L1", author: "carol", score: "", text: "  > Reply" },
      { type: "L1", author: "", score: "", text: "  [+1 more replies]" },
      { type: "L0", author: "bob", score: "", text: "Second" },
      { type: "", author: "", score: "", text: "[+1 more top-level comments]" },
    ]);
  });
});
