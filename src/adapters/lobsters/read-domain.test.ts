import { describe, expect, it } from "vitest";
import {
  buildLobstersReadRows,
  lobstersHtmlToText,
  mapLobstersDomainRows,
  requireLobstersDomain,
  requireLobstersLimit,
  requireLobstersMinInt,
  requireLobstersShortId,
} from "./read-domain.js";

describe("lobsters agent-facing read and domain commands", () => {
  it("validates ids, domains, limits, and HTML conversion", () => {
    expect(requireLobstersShortId(" 6cmh6h ")).toBe("6cmh6h");
    expect(() => requireLobstersShortId("bad/id")).toThrow("short_id");
    expect(requireLobstersDomain(" Blog.Cloudflare.com ")).toBe(
      "blog.cloudflare.com",
    );
    expect(() => requireLobstersDomain("localhost")).toThrow("valid hostname");
    expect(requireLobstersLimit(undefined, 20, 25, "limit")).toBe(20);
    expect(() => requireLobstersLimit(26, 20, 25, "limit")).toThrow("<= 25");
    expect(requireLobstersMinInt(undefined, 2000, 100, "max-length")).toBe(
      2000,
    );
    expect(() => requireLobstersMinInt(99, 2000, 100, "max-length")).toThrow(
      ">= 100",
    );
    expect(
      lobstersHtmlToText(
        '<p>Hello &amp; <code>Rust</code><br><a href="https://x.test">link</a></p>',
      ),
    ).toBe("Hello & `Rust`\nlink (https://x.test)");
  });

  it("builds story rows with bounded comment tree summaries", () => {
    const rows = buildLobstersReadRows(
      {
        short_id: "abc123",
        title: "Launch",
        description_plain: "Story body",
        submitter_user: "alice",
        score: 42,
        url: "https://example.test",
        comments: [
          {
            short_id: "c1",
            parent_comment: null,
            comment_plain: "First",
            commenting_user: "bob",
            score: 2,
          },
          {
            short_id: "c2",
            parent_comment: "c1",
            comment_plain: "Reply",
            commenting_user: "carol",
            score: 1,
          },
          {
            short_id: "c3",
            parent_comment: "c1",
            comment_plain: "Hidden",
            commenting_user: "dan",
            score: 0,
          },
          {
            short_id: "c4",
            parent_comment: null,
            comment_plain: "Second",
            commenting_user: "erin",
          },
        ],
      },
      { limit: 1, maxDepth: 2, maxReplies: 1, maxLength: 100 },
    );

    expect(rows).toEqual([
      {
        type: "POST",
        author: "alice",
        score: 42,
        text: "Launch\nStory body\nhttps://example.test",
      },
      { type: "L0", author: "bob", score: 2, text: "First" },
      { type: "L1", author: "carol", score: 1, text: "  > Reply" },
      { type: "L1", author: "", score: "", text: "  [+1 more replies]" },
      { type: "", author: "", score: "", text: "[+1 more top-level comments]" },
    ]);
  });

  it("maps domain rows with stable columns", () => {
    expect(
      mapLobstersDomainRows([
        {
          short_id: "6cmh6h",
          title: "Post",
          score: 5,
          submitter_user: "alice",
          comment_count: 3,
          created_at: "2026-05-12T00:00:00.000Z",
          tags: ["programming", "rust"],
          url: "https://example.test/post",
          comments_url: "https://lobste.rs/s/6cmh6h/post",
        },
      ]),
    ).toEqual([
      {
        rank: 1,
        id: "6cmh6h",
        title: "Post",
        score: 5,
        author: "alice",
        comments: 3,
        created_at: "2026-05-12",
        tags: "programming, rust",
        submission_url: "https://example.test/post",
        comments_url: "https://lobste.rs/s/6cmh6h/post",
      },
    ]);
  });
});
