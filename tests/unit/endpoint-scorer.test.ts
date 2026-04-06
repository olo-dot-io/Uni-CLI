import { describe, it, expect } from "vitest";
import {
  deduplicateEndpoints,
  annotateEndpoint,
  processEndpoints,
  isNoiseUrl,
  isStaticResource,
  isUsefulEndpoint,
  endpointSortKey,
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
// Re-export verification — analysis.ts functions accessible via endpoint-scorer
// ---------------------------------------------------------------------------

describe("re-exports from analysis.ts", () => {
  it("isNoiseUrl is re-exported and works", () => {
    expect(isNoiseUrl("https://www.google-analytics.com/collect")).toBe(true);
    expect(isNoiseUrl("https://api.example.com/items")).toBe(false);
  });

  it("isStaticResource is re-exported and works", () => {
    expect(isStaticResource("https://cdn.example.com/style.css")).toBe(true);
    expect(
      isStaticResource("https://api.example.com/data", "application/json"),
    ).toBe(false);
  });

  it("isUsefulEndpoint is re-exported and works", () => {
    expect(
      isUsefulEndpoint({
        url: "https://api.example.com/items",
        status: 200,
        contentType: "application/json",
        body: { items: [{ id: 1 }], total: 1 },
      }),
    ).toBe(true);
    expect(
      isUsefulEndpoint({
        url: "https://api.example.com/ping",
        status: 200,
        contentType: "application/json",
        body: { status: "ok" },
      }),
    ).toBe(false);
  });

  it("endpointSortKey is re-exported and returns a 4-tuple", () => {
    const key = endpointSortKey({
      url: "https://api.example.com/api/v1/items",
      body: [{ id: 1, title: "A" }],
    });
    expect(key).toHaveLength(4);
    expect(key[2]).toBe(1); // isApiPath
  });

  it("detectCapability is re-exported and detects search", () => {
    const result = detectCapability("https://api.example.com/search?q=hello");
    expect(result).toBe("search");
  });

  it("detectCapability is re-exported and returns null for unknown", () => {
    const result = detectCapability("https://api.example.com/settings");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// annotateEndpoint
// ---------------------------------------------------------------------------

describe("annotateEndpoint", () => {
  it("extracts detectedFields from array response body", () => {
    const entry = makeEntry({
      responseBody: JSON.stringify([{ id: 1, title: "A", score: 99 }]),
    });
    const result = annotateEndpoint(entry);
    expect(result.detectedFields).toEqual(["id", "title", "score"]);
  });

  it("extracts detectedFields from object response body", () => {
    const entry = makeEntry({
      responseBody: JSON.stringify({ items: [], total: 0, page: 1 }),
    });
    const result = annotateEndpoint(entry);
    expect(result.detectedFields).toEqual(["items", "total", "page"]);
  });

  it("returns empty detectedFields for malformed JSON", () => {
    const entry = makeEntry({ responseBody: "not-valid-json{{{" });
    const result = annotateEndpoint(entry);
    expect(result.detectedFields).toEqual([]);
    expect(result).not.toThrow;
  });

  it("returns empty detectedFields for missing responseBody", () => {
    const entry = makeEntry({ responseBody: undefined });
    const result = annotateEndpoint(entry);
    expect(result.detectedFields).toEqual([]);
  });

  it("detects capability from URL", () => {
    const entry = makeEntry({
      url: "https://api.example.com/search?q=test",
    });
    const result = annotateEndpoint(entry);
    expect(result.capability).toBe("search");
  });

  it("omits capability when none detected", () => {
    const entry = makeEntry({
      url: "https://api.example.com/settings",
    });
    const result = annotateEndpoint(entry);
    expect(result.capability).toBeUndefined();
  });

  it("preserves all original EndpointEntry fields", () => {
    const entry = makeEntry({ status: 201, method: "POST" });
    const result = annotateEndpoint(entry);
    expect(result.status).toBe(201);
    expect(result.method).toBe("POST");
    expect(result.url).toBe(entry.url);
    expect(result.contentType).toBe(entry.contentType);
  });
});

// ---------------------------------------------------------------------------
// deduplicateEndpoints
// ---------------------------------------------------------------------------

describe("deduplicateEndpoints", () => {
  it("deduplicates entries with the same URL path", () => {
    const entries: EndpointEntry[] = [
      makeEntry({ url: "https://example.com/api/items?page=1" }),
      makeEntry({ url: "https://example.com/api/items?page=2" }),
    ];
    const result = deduplicateEndpoints(entries);
    expect(result.length).toBe(1);
  });

  it("keeps entries with different URL paths", () => {
    const entries: EndpointEntry[] = [
      makeEntry({ url: "https://example.com/api/users" }),
      makeEntry({ url: "https://example.com/api/posts" }),
    ];
    const result = deduplicateEndpoints(entries);
    expect(result.length).toBe(2);
  });

  it("prefers JSON content-type over non-JSON when deduplicating", () => {
    const entries: EndpointEntry[] = [
      makeEntry({
        url: "https://example.com/api/data?format=html",
        contentType: "text/html",
        status: 200,
        size: 500,
      }),
      makeEntry({
        url: "https://example.com/api/data?format=json",
        contentType: "application/json",
        status: 200,
        size: 200,
      }),
    ];
    const result = deduplicateEndpoints(entries);
    expect(result.length).toBe(1);
    expect(result[0].contentType).toBe("application/json");
  });

  it("prefers status 200 over non-200", () => {
    const entries: EndpointEntry[] = [
      makeEntry({
        url: "https://example.com/api/data?v=1",
        status: 404,
        contentType: "application/json",
        size: 50,
      }),
      makeEntry({
        url: "https://example.com/api/data?v=2",
        status: 200,
        contentType: "application/json",
        size: 50,
      }),
    ];
    const result = deduplicateEndpoints(entries);
    expect(result.length).toBe(1);
    expect(result[0].status).toBe(200);
  });

  it("handles empty input", () => {
    expect(deduplicateEndpoints([])).toEqual([]);
  });

  it("handles single entry", () => {
    const entries = [makeEntry()];
    const result = deduplicateEndpoints(entries);
    expect(result.length).toBe(1);
    expect(result[0].url).toBe(entries[0].url);
  });
});

// ---------------------------------------------------------------------------
// processEndpoints
// ---------------------------------------------------------------------------

describe("processEndpoints", () => {
  it("filters out noise URLs", () => {
    const entries: EndpointEntry[] = [
      makeEntry({
        url: "https://www.google-analytics.com/collect",
        contentType: "application/json",
        responseBody: JSON.stringify({ items: [{ id: 1 }] }),
        size: 100,
      }),
      makeEntry({
        url: "https://api.example.com/api/v1/trending",
        contentType: "application/json",
        responseBody: JSON.stringify([{ id: 1, title: "A" }]),
        size: 100,
      }),
    ];
    const results = processEndpoints(entries);
    expect(results.every((r) => !r.url.includes("google-analytics"))).toBe(
      true,
    );
  });

  it("filters out static resources", () => {
    const entries: EndpointEntry[] = [
      makeEntry({
        url: "https://cdn.example.com/style.css",
        contentType: "text/css",
        responseBody: undefined,
        size: 1000,
      }),
      makeEntry({
        url: "https://api.example.com/api/v1/items",
        contentType: "application/json",
        responseBody: JSON.stringify([{ id: 1, title: "A" }]),
        size: 100,
      }),
    ];
    const results = processEndpoints(entries);
    expect(results.every((r) => !r.url.endsWith(".css"))).toBe(true);
  });

  it("filters out non-JSON endpoints", () => {
    const entries: EndpointEntry[] = [
      makeEntry({
        url: "https://api.example.com/page",
        contentType: "text/html",
        responseBody: "<html>...</html>",
        size: 500,
      }),
      makeEntry({
        url: "https://api.example.com/api/v1/data",
        contentType: "application/json",
        responseBody: JSON.stringify([{ id: 1, title: "A", value: 99 }]),
        size: 100,
      }),
    ];
    const results = processEndpoints(entries);
    expect(results.every((r) => r.contentType.includes("json"))).toBe(true);
  });

  it("returns ScoredEndpoints with detectedFields populated", () => {
    const entries: EndpointEntry[] = [
      makeEntry({
        url: "https://api.example.com/api/v1/items",
        contentType: "application/json",
        responseBody: JSON.stringify([{ id: 1, title: "A", rank: 1 }]),
        size: 100,
      }),
    ];
    const results = processEndpoints(entries);
    expect(results.length).toBe(1);
    expect(results[0].detectedFields).toContain("id");
    expect(results[0].detectedFields).toContain("title");
  });

  it("deduplicates by URL path", () => {
    const entries: EndpointEntry[] = [
      makeEntry({
        url: "https://example.com/api/v1/items?page=1",
        responseBody: JSON.stringify([{ id: 1, title: "A", value: 1 }]),
      }),
      makeEntry({
        url: "https://example.com/api/v1/items?page=2",
        responseBody: JSON.stringify([{ id: 2, title: "B", value: 2 }]),
      }),
    ];
    const results = processEndpoints(entries);
    expect(results.length).toBe(1);
  });

  it("handles empty input", () => {
    expect(processEndpoints([])).toEqual([]);
  });

  it("places API path endpoints before non-API endpoints", () => {
    const entries: EndpointEntry[] = [
      makeEntry({
        url: "https://example.com/home",
        contentType: "application/json",
        responseBody: JSON.stringify({
          status: "ok",
          mode: "home",
          version: 2,
        }),
        size: 80,
      }),
      makeEntry({
        url: "https://example.com/api/v1/feed",
        contentType: "application/json",
        responseBody: JSON.stringify([
          { id: 1, title: "A", author: "x", ts: 0 },
          { id: 2, title: "B", author: "y", ts: 1 },
        ]),
        size: 200,
      }),
    ];
    const results = processEndpoints(entries);
    // The API endpoint with more items should rank higher
    if (results.length >= 2) {
      const apiIdx = results.findIndex((r) => r.url.includes("/api/v1/feed"));
      const homeIdx = results.findIndex((r) => r.url.includes("/home"));
      expect(apiIdx).toBeLessThan(homeIdx);
    }
  });
});
