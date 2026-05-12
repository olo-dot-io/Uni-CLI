import { describe, expect, it } from "vitest";
import {
  buildTweetToggleScript,
  buildTwitterArticleScopeSource,
  parseTwitterTweetUrl,
} from "./tweet-actions.js";

describe("twitter agent-facing tweet actions", () => {
  it("validates full tweet URLs and extracts ids", () => {
    expect(parseTwitterTweetUrl("https://x.com/jack/status/20")).toEqual({
      id: "20",
      url: "https://x.com/jack/status/20",
    });
    expect(
      parseTwitterTweetUrl("https://mobile.twitter.com/i/status/123"),
    ).toEqual({
      id: "123",
      url: "https://mobile.twitter.com/i/status/123",
    });
    expect(() =>
      parseTwitterTweetUrl("https://example.com/jack/status/20"),
    ).toThrow("host");
    expect(() => parseTwitterTweetUrl("https://x.com/jack")).toThrow(
      "extract tweet ID",
    );
  });

  it("builds exact tweet-scoped article lookup", () => {
    const source = buildTwitterArticleScopeSource("123");
    expect(source).toContain('const tweetId = "123"');
    expect(source).toContain("findTargetArticle");
    expect(source).toContain("__twGetStatusIdFromHref(link.href) === tweetId");
  });

  it("builds unlike script with idempotent not-liked path", () => {
    const script = buildTweetToggleScript("unlike", "123");
    expect(script).toContain('[data-testid="unlike"]');
    expect(script).toContain('[data-testid="like"]');
    expect(script).toContain("Tweet is not liked (already unliked).");
    expect(script).toContain("Tweet successfully unliked.");
  });

  it("builds retweet and unretweet scripts with confirmation selectors", () => {
    expect(buildTweetToggleScript("retweet", "123")).toContain(
      '[data-testid="retweetConfirm"]',
    );
    expect(buildTweetToggleScript("unretweet", "123")).toContain(
      '[data-testid="unretweetConfirm"]',
    );
  });
});
