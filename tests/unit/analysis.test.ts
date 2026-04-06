/**
 * Tests for src/engine/analysis.ts — boolean endpoint filters + sort keys.
 */

import { describe, it, expect } from "vitest";
import {
  isNoiseUrl,
  isStaticResource,
  isUsefulEndpoint,
  endpointSortKey,
  detectCapability,
  formatDuration,
} from "../../src/engine/analysis.js";

// ---------------------------------------------------------------------------
// isNoiseUrl
// ---------------------------------------------------------------------------

describe("isNoiseUrl", () => {
  it("flags google-analytics domain", () => {
    expect(isNoiseUrl("https://www.google-analytics.com/collect?v=1")).toBe(
      true,
    );
  });

  it("flags googletagmanager domain", () => {
    expect(
      isNoiseUrl("https://www.googletagmanager.com/gtm.js?id=GTM-XXXXX"),
    ).toBe(true);
  });

  it("flags hotjar domain", () => {
    expect(isNoiseUrl("https://vc.hotjar.io/api/v2/sites/123/feedback")).toBe(
      true,
    );
  });

  it("flags sentry.io domain", () => {
    expect(
      isNoiseUrl("https://o123456.ingest.sentry.io/api/456/envelope/"),
    ).toBe(true);
  });

  it("flags doubleclick.net domain", () => {
    expect(isNoiseUrl("https://ad.doubleclick.net/ddm/activity/dc_ips=1")).toBe(
      true,
    );
  });

  it("flags connect.facebook.net domain", () => {
    expect(isNoiseUrl("https://connect.facebook.net/en_US/fbevents.js")).toBe(
      true,
    );
  });

  it("flags cdn.segment.com domain", () => {
    expect(isNoiseUrl("https://cdn.segment.com/analytics.min.js")).toBe(true);
  });

  it("flags api.segment.io domain", () => {
    expect(isNoiseUrl("https://api.segment.io/v1/track")).toBe(true);
  });

  it("flags mixpanel domain", () => {
    expect(isNoiseUrl("https://api.mixpanel.com/track/?data=xxx")).toBe(true);
  });

  it("flags amplitude domain", () => {
    expect(isNoiseUrl("https://api.amplitude.com/2/httpapi")).toBe(true);
  });

  it("flags clarity.ms domain", () => {
    expect(isNoiseUrl("https://d.clarity.ms/collect?xxx")).toBe(true);
  });

  it("flags /beacon path", () => {
    expect(isNoiseUrl("https://example.com/beacon")).toBe(true);
  });

  it("flags /pixel path", () => {
    expect(isNoiseUrl("https://example.com/pixel/1x1.gif")).toBe(true);
  });

  it("flags /track path", () => {
    expect(isNoiseUrl("https://example.com/track/event")).toBe(true);
  });

  it("flags /collect path", () => {
    expect(isNoiseUrl("https://example.com/collect")).toBe(true);
  });

  it("flags /analytics path", () => {
    expect(isNoiseUrl("https://example.com/analytics/events")).toBe(true);
  });

  it("flags /_next/data path (Next.js internals)", () => {
    expect(isNoiseUrl("https://example.com/_next/data/abc123/index.json")).toBe(
      true,
    );
  });

  it("flags .hot-update. files (webpack HMR)", () => {
    expect(isNoiseUrl("https://localhost:3000/main.abc123.hot-update.js")).toBe(
      true,
    );
  });

  it("does not flag a clean API endpoint", () => {
    expect(isNoiseUrl("https://api.example.com/v1/posts")).toBe(false);
  });

  it("does not flag a clean search endpoint", () => {
    expect(isNoiseUrl("https://search.example.com/api/results?q=hello")).toBe(
      false,
    );
  });

  it("does not flag a path that merely contains 'log' as a word in the domain", () => {
    expect(isNoiseUrl("https://blog.example.com/api/posts")).toBe(false);
  });

  it("does not flag URL where noise domain appears only in query param (redirect)", () => {
    // cdn.segment.com is in the query string, not the hostname — must return false
    expect(
      isNoiseUrl("https://myapp.com/page?redirect=https://cdn.segment.com/foo"),
    ).toBe(false);
  });

  it("flags facebook.com tracking pixel at /tr path", () => {
    expect(isNoiseUrl("https://www.facebook.com/tr?id=123&ev=PageView")).toBe(
      true,
    );
  });

  it("flags facebook.com domain even without /tr path", () => {
    expect(isNoiseUrl("https://www.facebook.com/plugins/like.php")).toBe(true);
  });

  it("flags /tr path on any domain (generic tracking pixel)", () => {
    expect(isNoiseUrl("https://example.com/tr")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isStaticResource
// ---------------------------------------------------------------------------

describe("isStaticResource", () => {
  it("flags .js extension", () => {
    expect(isStaticResource("https://cdn.example.com/bundle.js")).toBe(true);
  });

  it("flags .css extension", () => {
    expect(isStaticResource("https://cdn.example.com/style.css")).toBe(true);
  });

  it("flags .png extension", () => {
    expect(isStaticResource("https://cdn.example.com/logo.png")).toBe(true);
  });

  it("flags .woff2 extension", () => {
    expect(isStaticResource("https://cdn.example.com/font.woff2")).toBe(true);
  });

  it("flags .map extension (source map)", () => {
    expect(isStaticResource("https://cdn.example.com/app.js.map")).toBe(true);
  });

  it("flags .webp extension", () => {
    expect(isStaticResource("https://cdn.example.com/image.webp")).toBe(true);
  });

  it("flags image/* content-type", () => {
    expect(isStaticResource("https://example.com/anything", "image/png")).toBe(
      true,
    );
  });

  it("flags font/* content-type", () => {
    expect(isStaticResource("https://example.com/anything", "font/woff2")).toBe(
      true,
    );
  });

  it("flags text/css content-type", () => {
    expect(isStaticResource("https://example.com/anything", "text/css")).toBe(
      true,
    );
  });

  it("flags application/javascript content-type", () => {
    expect(
      isStaticResource(
        "https://example.com/anything",
        "application/javascript",
      ),
    ).toBe(true);
  });

  it("does not flag a JSON API URL", () => {
    expect(
      isStaticResource("https://api.example.com/v1/posts", "application/json"),
    ).toBe(false);
  });

  it("does not flag a plain URL with no extension", () => {
    expect(isStaticResource("https://api.example.com/v1/posts")).toBe(false);
  });

  it("content-type check takes precedence over URL extension", () => {
    // URL ends with .json but content-type says image — treat as static
    expect(
      isStaticResource("https://example.com/data.json", "image/svg+xml"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isUsefulEndpoint
// ---------------------------------------------------------------------------

describe("isUsefulEndpoint", () => {
  it("returns true for good JSON array response", () => {
    expect(
      isUsefulEndpoint({
        url: "https://api.example.com/posts",
        status: 200,
        contentType: "application/json",
        body: [{ id: 1, title: "Hello" }],
      }),
    ).toBe(true);
  });

  it("returns true for JSON object with multiple fields", () => {
    expect(
      isUsefulEndpoint({
        url: "https://api.example.com/user",
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: { id: 1, name: "Alice", email: "a@b.com" },
      }),
    ).toBe(true);
  });

  it("returns true when status is absent", () => {
    expect(
      isUsefulEndpoint({
        url: "https://api.example.com/items",
        contentType: "application/json",
        body: [{ id: 1 }],
      }),
    ).toBe(true);
  });

  it("returns false for empty object body", () => {
    expect(
      isUsefulEndpoint({
        url: "https://api.example.com/ping",
        status: 200,
        contentType: "application/json",
        body: {},
      }),
    ).toBe(false);
  });

  it("returns false for {status: 'ok'} trivial body", () => {
    expect(
      isUsefulEndpoint({
        url: "https://api.example.com/health",
        status: 200,
        contentType: "application/json",
        body: { status: "ok" },
      }),
    ).toBe(false);
  });

  it("returns false for {success: true} trivial body", () => {
    expect(
      isUsefulEndpoint({
        url: "https://api.example.com/action",
        status: 200,
        contentType: "application/json",
        body: { success: true },
      }),
    ).toBe(false);
  });

  it("returns false when contentType is absent", () => {
    expect(
      isUsefulEndpoint({
        url: "https://api.example.com/items",
        status: 200,
        body: [{ id: 1 }],
      }),
    ).toBe(false);
  });

  it("returns false for non-JSON content-type", () => {
    expect(
      isUsefulEndpoint({
        url: "https://api.example.com/items",
        status: 200,
        contentType: "text/html",
        body: { data: "something" },
      }),
    ).toBe(false);
  });

  it("returns false for 4xx status", () => {
    expect(
      isUsefulEndpoint({
        url: "https://api.example.com/items",
        status: 404,
        contentType: "application/json",
        body: { data: [{ id: 1 }] },
      }),
    ).toBe(false);
  });

  it("returns false for null body", () => {
    expect(
      isUsefulEndpoint({
        url: "https://api.example.com/items",
        status: 200,
        contentType: "application/json",
        body: null,
      }),
    ).toBe(false);
  });

  it("accepts +json content-type variants", () => {
    expect(
      isUsefulEndpoint({
        url: "https://api.example.com/items",
        status: 200,
        contentType: "application/vnd.api+json",
        body: { data: [{ id: 1, type: "post" }] },
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// endpointSortKey
// ---------------------------------------------------------------------------

describe("endpointSortKey", () => {
  it("returns [arrayLength, fieldCount, 1, 0] for top-level array on API path", () => {
    const key = endpointSortKey({
      url: "https://api.example.com/api/v1/posts",
      body: [
        { id: 1, title: "A", author: "X" },
        { id: 2, title: "B", author: "Y" },
      ],
    });
    expect(key).toEqual([2, 3, 1, 0]);
  });

  it("counts items in well-known top-level array field (data)", () => {
    const key = endpointSortKey({
      url: "https://example.com/posts",
      body: { data: [{ id: 1 }, { id: 2 }, { id: 3 }], total: 3 },
    });
    expect(key[0]).toBe(3); // itemCount from data[]
  });

  it("counts items in results field", () => {
    const key = endpointSortKey({
      url: "https://example.com/search",
      body: { results: [{ id: 1 }, { id: 2 }] },
    });
    expect(key[0]).toBe(2);
  });

  it("sets isApiPath=1 for /v2/ URLs", () => {
    const key = endpointSortKey({
      url: "https://example.com/v2/posts",
      body: [],
    });
    expect(key[2]).toBe(1);
  });

  it("sets isApiPath=1 for /graphql URLs", () => {
    const key = endpointSortKey({
      url: "https://example.com/graphql",
      body: {},
    });
    expect(key[2]).toBe(1);
  });

  it("sets isApiPath=0 for non-API path", () => {
    const key = endpointSortKey({
      url: "https://example.com/posts",
      body: [],
    });
    expect(key[2]).toBe(0);
  });

  it("sets hasParams=1 when URL has query string", () => {
    const key = endpointSortKey({
      url: "https://example.com/api/posts?page=1",
      body: [],
    });
    expect(key[3]).toBe(1);
  });

  it("sets hasParams=0 when URL has no query string", () => {
    const key = endpointSortKey({
      url: "https://example.com/api/posts",
      body: [],
    });
    expect(key[3]).toBe(0);
  });

  it("returns [0,0,0,0] for null body on plain path", () => {
    const key = endpointSortKey({
      url: "https://example.com/items",
      body: null,
    });
    expect(key).toEqual([0, 0, 0, 0]);
  });

  it("fieldCount reflects fields in first item of array", () => {
    const key = endpointSortKey({
      url: "https://example.com/api/items",
      body: [{ a: 1, b: 2, c: 3, d: 4 }],
    });
    expect(key[1]).toBe(4);
  });

  it("sets isApiPath=0 when /api/ appears only in query param, not pathname", () => {
    // Pathname is /data — /api/ is inside a query param value
    const key = endpointSortKey({
      url: "https://example.com/data?source=/api/v1/feed",
      body: [],
    });
    expect(key[2]).toBe(0);
  });

  it("uses first array item field count for wrapped responses", () => {
    // Wrapper has 2 keys (data, total), but first item has 3 fields
    const key = endpointSortKey({
      url: "https://example.com/posts",
      body: {
        data: [
          { id: 1, title: "A", author: "X" },
          { id: 2, title: "B", author: "Y" },
        ],
        total: 100,
      },
    });
    expect(key[0]).toBe(2); // itemCount = data.length
    expect(key[1]).toBe(3); // fieldCount = first item's keys, not wrapper's
  });
});

// ---------------------------------------------------------------------------
// detectCapability
// ---------------------------------------------------------------------------

describe("detectCapability", () => {
  it("detects search from URL path", () => {
    expect(detectCapability("https://api.example.com/search?q=hello")).toBe(
      "search",
    );
  });

  it("detects search from /query path", () => {
    expect(detectCapability("https://api.example.com/query/results")).toBe(
      "search",
    );
  });

  it("detects hot from /hot path", () => {
    expect(detectCapability("https://api.example.com/hot/list")).toBe("hot");
  });

  it("detects hot from /trending path", () => {
    expect(detectCapability("https://api.example.com/trending")).toBe("hot");
  });

  it("detects hot from /popular path", () => {
    expect(detectCapability("https://api.example.com/popular?limit=10")).toBe(
      "hot",
    );
  });

  it("detects feed from /feed path", () => {
    expect(detectCapability("https://api.example.com/feed")).toBe("feed");
  });

  it("detects feed from /timeline path", () => {
    expect(detectCapability("https://api.example.com/timeline")).toBe("feed");
  });

  it("detects feed from /latest path", () => {
    expect(detectCapability("https://api.example.com/latest")).toBe("feed");
  });

  it("detects profile from /user path", () => {
    expect(detectCapability("https://api.example.com/user/123")).toBe(
      "profile",
    );
  });

  it("detects profile from /me path", () => {
    expect(detectCapability("https://api.example.com/me")).toBe("profile");
  });

  it("detects comments from /comment path", () => {
    expect(detectCapability("https://api.example.com/comment/list")).toBe(
      "comments",
    );
  });

  it("detects comments from /review path", () => {
    expect(detectCapability("https://api.example.com/review")).toBe("comments");
  });

  it("detects detail from /article path", () => {
    expect(detectCapability("https://api.example.com/article/456")).toBe(
      "detail",
    );
  });

  it("detects detail from /post path", () => {
    expect(detectCapability("https://api.example.com/post/789")).toBe("detail");
  });

  it("detects download from /media path", () => {
    expect(detectCapability("https://api.example.com/media/123")).toBe(
      "download",
    );
  });

  it("detects download from /video path", () => {
    expect(detectCapability("https://api.example.com/video/play")).toBe(
      "download",
    );
  });

  it("falls back to body field heuristic: title+url => feed", () => {
    expect(
      detectCapability("https://api.example.com/misc", [
        { id: 1, title: "Post", url: "https://example.com/1" },
      ]),
    ).toBe("feed");
  });

  it("falls back to body field heuristic: price+name => product", () => {
    expect(
      detectCapability("https://api.example.com/misc", [
        { id: 1, price: "9.99", name: "Widget" },
      ]),
    ).toBe("product");
  });

  it("falls back to body field heuristic: author+content => article", () => {
    expect(
      detectCapability("https://api.example.com/misc", [
        { author: "Alice", content: "Long text here..." },
      ]),
    ).toBe("article");
  });

  it("returns null for unrecognized URL and body", () => {
    expect(
      detectCapability("https://api.example.com/settings", {
        theme: "dark",
        lang: "en",
      }),
    ).toBeNull();
  });

  it("returns null when body is absent", () => {
    expect(detectCapability("https://api.example.com/settings")).toBeNull();
  });

  it("URL patterns take priority over body heuristics", () => {
    // URL says /search, body looks like a feed — search wins
    expect(
      detectCapability("https://api.example.com/search", [
        { title: "Post", url: "https://example.com/1" },
      ]),
    ).toBe("search");
  });

  it("does not match /search in query param as search capability", () => {
    // Pathname is /api/data — /search only appears in a query param
    expect(
      detectCapability("https://api.example.com/api/data?fallback=/search"),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
  it("formats 0ms", () => {
    expect(formatDuration(0)).toBe("0ms");
  });

  it("formats sub-second durations with ms suffix", () => {
    expect(formatDuration(42)).toBe("42ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("formats exactly 1 second", () => {
    expect(formatDuration(1000)).toBe("1.0s");
  });

  it("formats seconds with one decimal", () => {
    expect(formatDuration(3200)).toBe("3.2s");
  });

  it("formats 59.9s still as seconds", () => {
    expect(formatDuration(59_900)).toBe("59.9s");
  });

  it("formats exactly 1 minute", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
  });

  it("formats 1 minute 23 seconds", () => {
    expect(formatDuration(83_000)).toBe("1m 23s");
  });

  it("formats multi-minute durations", () => {
    expect(formatDuration(125_000)).toBe("2m 5s");
  });
});
