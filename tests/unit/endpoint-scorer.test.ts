import { describe, it, expect } from "vitest";
import {
  scoreEndpoint,
  scoreEndpoints,
  detectCapability,
  type EndpointEntry,
} from "../../src/engine/endpoint-scorer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<EndpointEntry> = {}): EndpointEntry {
  return {
    url: "https://example.com/api/v1/items",
    method: "GET",
    status: 200,
    contentType: "application/json",
    responseBody: JSON.stringify([{ id: 1, title: "Hello", score: 42 }]),
    size: 100,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Individual scoring rules
// ---------------------------------------------------------------------------

describe("scoreEndpoint", () => {
  it("gives +10 for json content-type", () => {
    const result = scoreEndpoint(
      makeEntry({ contentType: "application/json" }),
    );
    expect(result.reasons).toContainEqual(
      expect.stringContaining("+10 content-type json"),
    );
  });

  it("gives +10 for content-type with charset", () => {
    const result = scoreEndpoint(
      makeEntry({ contentType: "application/json; charset=utf-8" }),
    );
    expect(result.reasons).toContainEqual(
      expect.stringContaining("+10 content-type json"),
    );
  });

  it("gives +8 for non-empty array response", () => {
    const body = JSON.stringify([{ a: 1 }, { a: 2 }]);
    const result = scoreEndpoint(makeEntry({ responseBody: body }));
    expect(result.reasons).toContainEqual(
      expect.stringContaining("+8 response is non-empty array"),
    );
  });

  it("does not give +8 for empty array", () => {
    const body = JSON.stringify([]);
    const result = scoreEndpoint(makeEntry({ responseBody: body }));
    expect(result.reasons).not.toContainEqual(
      expect.stringContaining("+8 response is non-empty array"),
    );
  });

  it("gives +5 for nested array field in object response", () => {
    const body = JSON.stringify({ data: { items: [1, 2, 3] }, total: 100 });
    const result = scoreEndpoint(makeEntry({ responseBody: body }));
    // The top-level value "data" is an object, not an array.
    // But let's provide a true nested array at top level:
    const body2 = JSON.stringify({ items: [1, 2, 3], total: 100 });
    const result2 = scoreEndpoint(makeEntry({ responseBody: body2 }));
    expect(result2.reasons).toContainEqual(
      expect.stringContaining("+5 response has nested array field"),
    );
  });

  it("does not give +5 for top-level array (that gets +8 instead)", () => {
    const body = JSON.stringify([{ id: 1 }]);
    const result = scoreEndpoint(makeEntry({ responseBody: body }));
    expect(result.reasons).not.toContainEqual(
      expect.stringContaining("+5 response has nested array field"),
    );
  });

  it("gives field count score capped at 20", () => {
    // Create an item with 15 fields -> 15*2=30, capped to 20
    const fields: Record<string, number> = {};
    for (let i = 0; i < 15; i++) fields[`field${i}`] = i;
    const body = JSON.stringify([fields]);
    const result = scoreEndpoint(makeEntry({ responseBody: body }));
    expect(result.reasons).toContainEqual(
      expect.stringContaining("+20 detected 15 fields"),
    );
    expect(result.detectedFields).toHaveLength(15);
  });

  it("gives 2N for small field counts", () => {
    const body = JSON.stringify([{ id: 1, name: "x", value: 3 }]);
    const result = scoreEndpoint(makeEntry({ responseBody: body }));
    expect(result.reasons).toContainEqual(
      expect.stringContaining("+6 detected 3 fields"),
    );
    expect(result.detectedFields).toEqual(["id", "name", "value"]);
  });

  it("gives +4 for /api/ in URL", () => {
    const result = scoreEndpoint(
      makeEntry({ url: "https://example.com/api/data" }),
    );
    expect(result.reasons).toContainEqual(
      expect.stringContaining("+4 url matches /api/"),
    );
  });

  it("gives +4 for /v2/ in URL", () => {
    const result = scoreEndpoint(
      makeEntry({ url: "https://example.com/v2/items" }),
    );
    expect(result.reasons).toContainEqual(
      expect.stringContaining("+4 url matches /api/"),
    );
  });

  it("gives +3 for search/query param", () => {
    const result = scoreEndpoint(
      makeEntry({ url: "https://example.com/api/search?q=hello&limit=10" }),
    );
    expect(result.reasons).toContainEqual(
      expect.stringContaining("+3 url has search/query param"),
    );
  });

  it("gives +2 for pagination param", () => {
    const result = scoreEndpoint(
      makeEntry({ url: "https://example.com/api/items?page=2" }),
    );
    expect(result.reasons).toContainEqual(
      expect.stringContaining("+2 url has pagination param"),
    );
  });

  it("gives +2 for limit param", () => {
    const result = scoreEndpoint(
      makeEntry({ url: "https://example.com/api/items?limit=20" }),
    );
    expect(result.reasons).toContainEqual(
      expect.stringContaining("+2 url has limit/count/size param"),
    );
  });

  it("gives +2 for status 200", () => {
    const result = scoreEndpoint(makeEntry({ status: 200 }));
    expect(result.reasons).toContainEqual(
      expect.stringContaining("+2 status 200"),
    );
  });

  it("does not give +2 for non-200 status", () => {
    const result = scoreEndpoint(makeEntry({ status: 304 }));
    expect(result.reasons).not.toContainEqual(
      expect.stringContaining("+2 status 200"),
    );
  });

  it("gives -5 for google-analytics tracking URL", () => {
    const result = scoreEndpoint(
      makeEntry({ url: "https://www.google-analytics.com/collect?v=1" }),
    );
    expect(result.reasons).toContainEqual(
      expect.stringContaining("-5 tracking/analytics url"),
    );
  });

  it("gives -5 for sentry tracking URL", () => {
    const result = scoreEndpoint(
      makeEntry({ url: "https://o123.ingest.sentry.io/api/456/envelope" }),
    );
    expect(result.reasons).toContainEqual(
      expect.stringContaining("-5 tracking/analytics url"),
    );
  });

  it("gives -5 for doubleclick URL", () => {
    const result = scoreEndpoint(
      makeEntry({ url: "https://ad.doubleclick.net/ddm/activity" }),
    );
    expect(result.reasons).toContainEqual(
      expect.stringContaining("-5 tracking/analytics url"),
    );
  });

  it("gives -5 for hotjar URL", () => {
    const result = scoreEndpoint(
      makeEntry({ url: "https://in.hotjar.com/api/v2/client/sites/123" }),
    );
    expect(result.reasons).toContainEqual(
      expect.stringContaining("-5 tracking/analytics url"),
    );
  });

  it("gives -3 for image content-type", () => {
    const result = scoreEndpoint(makeEntry({ contentType: "image/png" }));
    expect(result.reasons).toContainEqual(
      expect.stringContaining("-3 non-data content-type"),
    );
  });

  it("gives -3 for font content-type", () => {
    const result = scoreEndpoint(makeEntry({ contentType: "font/woff2" }));
    expect(result.reasons).toContainEqual(
      expect.stringContaining("-3 non-data content-type"),
    );
  });

  it("gives -3 for css content-type", () => {
    const result = scoreEndpoint(makeEntry({ contentType: "text/css" }));
    expect(result.reasons).toContainEqual(
      expect.stringContaining("-3 non-data content-type"),
    );
  });

  it("gives -3 for javascript content-type", () => {
    const result = scoreEndpoint(
      makeEntry({ contentType: "application/javascript" }),
    );
    expect(result.reasons).toContainEqual(
      expect.stringContaining("-3 non-data content-type"),
    );
  });

  it("gives -3 for empty response body", () => {
    const result = scoreEndpoint(
      makeEntry({ responseBody: undefined, size: 0 }),
    );
    expect(result.reasons).toContainEqual(
      expect.stringContaining("-3 empty or small response body"),
    );
  });

  it("gives -3 for very small response body", () => {
    const result = scoreEndpoint(makeEntry({ responseBody: "{}", size: 2 }));
    expect(result.reasons).toContainEqual(
      expect.stringContaining("-3 empty or small response body"),
    );
  });

  it("accumulates all applicable bonuses for a strong API endpoint", () => {
    const entry = makeEntry({
      url: "https://api.example.com/api/v1/search?q=test&page=1&limit=20",
      status: 200,
      contentType: "application/json",
      responseBody: JSON.stringify({
        results: [{ id: 1, title: "Test", score: 99 }],
        total: 1,
      }),
      size: 200,
    });
    const result = scoreEndpoint(entry);
    // +10 json, +5 nested array, field count, +4 api path, +3 search, +2 page, +2 limit, +2 status
    expect(result.score).toBeGreaterThanOrEqual(25);
    expect(result.capability).toBe("search");
  });
});

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

describe("detectCapability", () => {
  it("detects trending from URL", () => {
    expect(detectCapability("https://api.example.com/hot/list", [])).toBe(
      "trending",
    );
  });

  it("detects trending from fields", () => {
    expect(
      detectCapability("https://api.example.com/data", ["rank", "title"]),
    ).toBe("trending");
  });

  it("detects search", () => {
    expect(detectCapability("https://api.example.com/search?q=hello", [])).toBe(
      "search",
    );
  });

  it("detects profile", () => {
    expect(detectCapability("https://api.example.com/user/123", [])).toBe(
      "profile",
    );
  });

  it("detects profile from /me endpoint", () => {
    expect(detectCapability("https://api.example.com/me", [])).toBe("profile");
  });

  it("detects detail", () => {
    expect(detectCapability("https://api.example.com/article/456", [])).toBe(
      "detail",
    );
  });

  it("detects comments", () => {
    expect(detectCapability("https://api.example.com/comment/list", [])).toBe(
      "comments",
    );
  });

  it("detects timeline", () => {
    expect(detectCapability("https://api.example.com/feed", [])).toBe(
      "timeline",
    );
  });

  it("detects download", () => {
    expect(detectCapability("https://api.example.com/media/123", [])).toBe(
      "download",
    );
  });

  it("returns undefined for unrecognized patterns", () => {
    expect(
      detectCapability("https://api.example.com/settings", ["theme", "lang"]),
    ).toBeUndefined();
  });

  it("matches first applicable capability (priority order)", () => {
    // URL contains both "hot" (trending) and "search" — trending comes first
    expect(detectCapability("https://api.example.com/hot/search", [])).toBe(
      "trending",
    );
  });
});

// ---------------------------------------------------------------------------
// scoreEndpoints — sort + deduplicate
// ---------------------------------------------------------------------------

describe("scoreEndpoints", () => {
  it("returns results sorted by score descending", () => {
    const entries: EndpointEntry[] = [
      makeEntry({
        url: "https://example.com/static/style.css",
        contentType: "text/css",
        responseBody: undefined,
        size: 5,
      }),
      makeEntry({
        url: "https://example.com/api/v1/trending",
        contentType: "application/json",
        responseBody: JSON.stringify([{ id: 1, title: "A" }]),
        size: 100,
      }),
    ];
    const results = scoreEndpoints(entries);
    expect(results.length).toBe(2);
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    expect(results[0].url).toContain("/api/v1/trending");
  });

  it("deduplicates by URL path, keeping higher score", () => {
    const entries: EndpointEntry[] = [
      makeEntry({
        url: "https://example.com/api/items?page=1",
        status: 200,
        size: 500,
        responseBody: JSON.stringify([{ id: 1, title: "A", score: 1 }]),
      }),
      makeEntry({
        url: "https://example.com/api/items?page=2",
        status: 200,
        size: 300,
        responseBody: JSON.stringify([{ id: 2, title: "B" }]),
      }),
    ];
    const results = scoreEndpoints(entries);
    // Same path /api/items — only one should remain
    expect(results.length).toBe(1);
  });

  it("keeps different paths even if similar", () => {
    const entries: EndpointEntry[] = [
      makeEntry({ url: "https://example.com/api/users" }),
      makeEntry({ url: "https://example.com/api/posts" }),
    ];
    const results = scoreEndpoints(entries);
    expect(results.length).toBe(2);
  });

  it("handles empty input", () => {
    const results = scoreEndpoints([]);
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles malformed JSON in responseBody gracefully", () => {
    const result = scoreEndpoint(
      makeEntry({ responseBody: "not-valid-json{{{", size: 50 }),
    );
    // Should not throw; no array/field bonuses
    expect(result.detectedFields).toEqual([]);
    expect(result.reasons).not.toContainEqual(
      expect.stringContaining("+8 response is non-empty array"),
    );
  });

  it("handles malformed URL gracefully", () => {
    const result = scoreEndpoint(makeEntry({ url: "not-a-url" }));
    // Should not throw; no search/pagination bonuses
    expect(result.score).toBeDefined();
  });

  it("handles missing responseBody and zero size", () => {
    const result = scoreEndpoint(
      makeEntry({ responseBody: undefined, size: 0 }),
    );
    expect(result.reasons).toContainEqual(
      expect.stringContaining("-3 empty or small response body"),
    );
  });

  it("handles responseBody that is a JSON string (not object or array)", () => {
    const result = scoreEndpoint(
      makeEntry({ responseBody: '"just a string"', size: 20 }),
    );
    expect(result.detectedFields).toEqual([]);
  });

  it("handles responseBody that is a JSON number", () => {
    const result = scoreEndpoint(makeEntry({ responseBody: "42", size: 10 }));
    expect(result.detectedFields).toEqual([]);
  });

  it("handles responseBody with nested object (no array)", () => {
    const body = JSON.stringify({
      user: { name: "Alice" },
      settings: { theme: "dark" },
    });
    const result = scoreEndpoint(makeEntry({ responseBody: body, size: 80 }));
    expect(result.reasons).not.toContainEqual(
      expect.stringContaining("+8 response is non-empty array"),
    );
    expect(result.reasons).not.toContainEqual(
      expect.stringContaining("+5 response has nested array field"),
    );
    expect(result.detectedFields).toEqual(["user", "settings"]);
  });

  it("scoreEndpoints dedup uses highest-scoring variant", () => {
    // Same path, different query params → different scores due to search param bonus
    const entries: EndpointEntry[] = [
      makeEntry({
        url: "https://example.com/api/data",
        status: 404,
        contentType: "text/html",
        responseBody: undefined,
        size: 0,
      }),
      makeEntry({
        url: "https://example.com/api/data?q=test",
        status: 200,
        contentType: "application/json",
        responseBody: JSON.stringify([{ id: 1, title: "hi" }]),
        size: 100,
      }),
    ];
    const results = scoreEndpoints(entries);
    // Should keep the higher-scored one (the JSON 200 with search param)
    expect(results.length).toBe(1);
    expect(results[0].status).toBe(200);
  });

  it("handles entry with all penalties and no bonuses", () => {
    const result = scoreEndpoint({
      url: "https://www.google-analytics.com/collect",
      method: "POST",
      status: 204,
      contentType: "image/gif",
      responseBody: undefined,
      size: 0,
    });
    expect(result.score).toBeLessThan(0);
  });
});
