import { describe, expect, it } from "vitest";
import {
  mapDevtoArticleRow,
  requireDevtoArticleId,
  requireDevtoMaxLength,
} from "./read.js";

describe("devto agent-facing read command", () => {
  it("validates ids and max-length", () => {
    expect(requireDevtoArticleId(" 3605688 ")).toBe("3605688");
    expect(() => requireDevtoArticleId("slug")).toThrow("Invalid DEV.to");
    expect(requireDevtoMaxLength(undefined)).toBe(20_000);
    expect(requireDevtoMaxLength("100")).toBe(100);
    expect(() => requireDevtoMaxLength("99")).toThrow("max-length");
  });

  it("maps article body, tags, and explicit truncation", () => {
    expect(
      mapDevtoArticleRow(
        {
          id: 3605688,
          title: "Readable",
          body_markdown: `${"x".repeat(105)}`,
          user: { username: "author" },
          public_reactions_count: 7,
          reading_time_minutes: 3,
          tag_list: ["ai", "cli"],
          published_at: "2026-05-12T00:00:00Z",
          url: "https://dev.to/a/readable",
        },
        "3605688",
        100,
      ),
    ).toEqual({
      id: 3605688,
      title: "Readable",
      author: "author",
      reactions: 7,
      reading_time: 3,
      tags: "ai, cli",
      published_at: "2026-05-12T00:00:00Z",
      body: `${"x".repeat(100)}\n\n... [truncated]`,
      url: "https://dev.to/a/readable",
    });
    expect(() => mapDevtoArticleRow({ id: 1 }, "1", 100)).toThrow(
      "body_markdown",
    );
  });
});
