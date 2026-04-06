/**
 * Unit tests for record command utility functions.
 *
 * Tests only pure functions (no browser required):
 *   - templatizeUrl
 *   - deduplicateRequests
 *   - isWriteCandidate
 *   - analyzeRequests (write candidate detection)
 *   - buildWriteCandidateYaml
 */

import { describe, it, expect } from "vitest";
import {
  templatizeUrl,
  deduplicateRequests,
  isWriteCandidate,
  analyzeRequests,
  buildWriteCandidateYaml,
} from "../../src/commands/record.js";
import type { RecordedRequest, ScoredCandidate } from "../../src/commands/record.js";

// ── templatizeUrl ─────────────────────────────────────────────────────────────

describe("templatizeUrl", () => {
  it("returns original URL for invalid input", () => {
    const result = templatizeUrl("not-a-url");
    expect(result.url).toBe("not-a-url");
    expect(result.args).toHaveLength(0);
  });

  it("leaves URLs with no known params unchanged", () => {
    const result = templatizeUrl("https://api.example.com/v1/items");
    expect(result.url).toBe("https://api.example.com/v1/items");
    expect(result.args).toHaveLength(0);
  });

  it("templatizes query param 'q' → args.query (required, no default)", () => {
    const result = templatizeUrl("https://api.example.com/search?q=hello");
    expect(result.url).toContain("${{ args.query }}");
    expect(result.args).toHaveLength(1);
    expect(result.args[0]).toMatchObject({ name: "query", required: true });
  });

  it("templatizes query param 'query' → args.query", () => {
    const result = templatizeUrl(
      "https://api.example.com/search?query=typescript",
    );
    expect(result.url).toContain("${{ args.query }}");
    expect(result.args[0]).toMatchObject({ name: "query", required: true });
  });

  it("templatizes 'page' → args.page with default 1", () => {
    const result = templatizeUrl(
      "https://api.example.com/items?page=2&limit=10",
    );
    expect(result.url).toContain("${{ args.page | default(1) }}");
    expect(result.url).toContain("${{ args.limit | default(20) }}");
    expect(result.args.find((a) => a.name === "page")).toMatchObject({
      name: "page",
      required: false,
    });
    expect(result.args.find((a) => a.name === "limit")).toMatchObject({
      name: "limit",
      required: false,
    });
  });

  it("templatizes 'size' → args.limit with default 20", () => {
    const result = templatizeUrl("https://api.example.com/posts?size=50");
    expect(result.url).toContain("${{ args.limit | default(20) }}");
  });

  it("templatizes 'id' → args.id (required)", () => {
    const result = templatizeUrl("https://api.example.com/item?id=42");
    expect(result.url).toContain("${{ args.id }}");
    expect(result.args[0]).toMatchObject({ name: "id", required: true });
  });

  it("templatizes 'sort' → args.sort with empty string default", () => {
    const result = templatizeUrl(
      "https://api.example.com/list?sort=created_at",
    );
    expect(result.url).toContain('${{ args.sort | default("") }}');
  });

  it("templatizes 'type' param → args.type with default", () => {
    const result = templatizeUrl("https://api.example.com/list?type=article");
    expect(result.url).toContain('${{ args.type | default("") }}');
  });

  it("replaces numeric path segments > 3 digits with ${{ args.id }}", () => {
    const result = templatizeUrl("https://api.example.com/users/12345/posts");
    expect(result.url).toContain("${{ args.id }}");
    expect(result.url).not.toContain("12345");
    expect(result.args.find((a) => a.name === "id")).toBeDefined();
  });

  it("does NOT replace short numeric segments (3 digits or fewer)", () => {
    const result = templatizeUrl("https://api.example.com/api/v1/123");
    // 123 is 3 digits — should NOT be templatized
    expect(result.url).toContain("/123");
    expect(result.url).not.toContain("${{ args.id }}");
  });

  it("handles both numeric path segment and query params simultaneously", () => {
    const result = templatizeUrl(
      "https://api.example.com/users/99999/posts?page=1&q=test",
    );
    expect(result.url).toContain("${{ args.id }}");
    expect(result.url).toContain("${{ args.page | default(1) }}");
    expect(result.url).toContain("${{ args.query }}");
    // Should not duplicate id arg
    const idArgs = result.args.filter((a) => a.name === "id");
    expect(idArgs).toHaveLength(1);
  });

  it("deduplicates args with same varName from different param aliases", () => {
    // 'keyword' and 'q' both map to 'query' — only one arg should appear
    const result = templatizeUrl(
      "https://api.example.com/search?q=foo&keyword=bar",
    );
    const queryArgs = result.args.filter((a) => a.name === "query");
    expect(queryArgs).toHaveLength(1);
  });

  it("preserves unknown query params unchanged", () => {
    const result = templatizeUrl(
      "https://api.example.com/items?custom_param=value",
    );
    expect(result.url).toContain("custom_param=value");
    expect(result.args).toHaveLength(0);
  });
});

// ── deduplicateRequests ───────────────────────────────────────────────────────

describe("deduplicateRequests", () => {
  it("returns single request when no duplicates", () => {
    const reqs: RecordedRequest[] = [
      { url: "https://api.example.com/items", data: [1, 2, 3], ts: 1 },
    ];
    const result = deduplicateRequests(reqs);
    expect(result).toHaveLength(1);
  });

  it("deduplicates two identical URL + method pairs", () => {
    const reqs: RecordedRequest[] = [
      {
        url: "https://api.example.com/items?page=1",
        data: [1],
        ts: 1,
        method: "GET",
      },
      {
        url: "https://api.example.com/items?page=2",
        data: [1, 2, 3, 4, 5],
        ts: 2,
        method: "GET",
      },
    ];
    const result = deduplicateRequests(reqs);
    // Both normalize to same key (param names only, values stripped)
    expect(result).toHaveLength(1);
    // Should keep the richer response (5 items vs 1 item)
    expect((result[0].data as unknown[]).length).toBe(5);
  });

  it("does NOT deduplicate different methods on same URL", () => {
    const reqs: RecordedRequest[] = [
      {
        url: "https://api.example.com/items",
        data: [],
        ts: 1,
        method: "GET",
      },
      {
        url: "https://api.example.com/items",
        data: null,
        ts: 2,
        method: "POST",
      },
    ];
    const result = deduplicateRequests(reqs);
    expect(result).toHaveLength(2);
  });

  it("deduplicates numeric path segments (IDs)", () => {
    const reqs: RecordedRequest[] = [
      { url: "https://api.example.com/user/11111/posts", data: [1], ts: 1 },
      {
        url: "https://api.example.com/user/22222/posts",
        data: [1, 2, 3],
        ts: 2,
      },
    ];
    const result = deduplicateRequests(reqs);
    expect(result).toHaveLength(1);
    // Richer response kept
    expect((result[0].data as unknown[]).length).toBe(3);
  });

  it("keeps the richer response (nested object with array)", () => {
    const reqs: RecordedRequest[] = [
      {
        url: "https://api.example.com/feed",
        data: { items: [1, 2] },
        ts: 1,
        method: "GET",
      },
      {
        url: "https://api.example.com/feed",
        data: { items: [1, 2, 3, 4, 5] },
        ts: 2,
        method: "GET",
      },
    ];
    const result = deduplicateRequests(reqs);
    expect(result).toHaveLength(1);
    expect(
      ((result[0].data as Record<string, unknown[]>).items as unknown[]).length,
    ).toBe(5);
  });
});

// ── isWriteCandidate ──────────────────────────────────────────────────────────

describe("isWriteCandidate", () => {
  it("returns false for GET requests", () => {
    const req: RecordedRequest = {
      url: "https://api.example.com/items",
      data: [],
      ts: 1,
      method: "GET",
    };
    expect(isWriteCandidate(req)).toBe(false);
  });

  it("returns false when method is undefined (defaults to GET)", () => {
    const req: RecordedRequest = {
      url: "https://api.example.com/items",
      data: [],
      ts: 1,
    };
    expect(isWriteCandidate(req)).toBe(false);
  });

  it("returns true for POST requests", () => {
    const req: RecordedRequest = {
      url: "https://api.example.com/items",
      data: { id: 1 },
      ts: 1,
      method: "POST",
    };
    expect(isWriteCandidate(req)).toBe(true);
  });

  it("returns true for PUT requests", () => {
    const req: RecordedRequest = {
      url: "https://api.example.com/items/1",
      data: {},
      ts: 1,
      method: "PUT",
    };
    expect(isWriteCandidate(req)).toBe(true);
  });

  it("returns true for PATCH requests", () => {
    const req: RecordedRequest = {
      url: "https://api.example.com/items/1",
      data: {},
      ts: 1,
      method: "PATCH",
    };
    expect(isWriteCandidate(req)).toBe(true);
  });

  it("returns true for DELETE requests", () => {
    const req: RecordedRequest = {
      url: "https://api.example.com/items/1",
      data: null,
      ts: 1,
      method: "DELETE",
    };
    expect(isWriteCandidate(req)).toBe(true);
  });

  it("is case-insensitive for method matching", () => {
    const req: RecordedRequest = {
      url: "https://api.example.com/items",
      data: {},
      ts: 1,
      method: "post",
    };
    expect(isWriteCandidate(req)).toBe(true);
  });
});

// ── analyzeRequests (write candidate detection) ───────────────────────────────

describe("analyzeRequests — write candidate separation", () => {
  it("separates GET and POST into read vs write candidates", () => {
    const reqs: RecordedRequest[] = [
      {
        url: "https://api.example.com/api/items",
        data: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        ts: 1,
        method: "GET",
      },
      {
        url: "https://api.example.com/api/items",
        data: { id: 42 },
        ts: 2,
        method: "POST",
        requestBody: { title: "new item" },
      },
    ];

    const { readCandidates, writeCandidates } = analyzeRequests(reqs);
    expect(readCandidates.length).toBeGreaterThanOrEqual(1);
    expect(writeCandidates.length).toBe(1);
    expect(writeCandidates[0].isWrite).toBe(true);
    expect(writeCandidates[0].method).toBe("POST");
  });

  it("excludes tracking URLs from all candidates", () => {
    const reqs: RecordedRequest[] = [
      {
        url: "https://analytics.example.com/collect?v=1",
        data: {},
        ts: 1,
        method: "POST",
      },
    ];
    const { readCandidates, writeCandidates } = analyzeRequests(reqs);
    // Write candidates bypass the score threshold, but tracking URLs get score -10
    // The current logic: write candidates use max(score, 5), but score for tracking is -10
    // Adjusted: tracking check applies before the threshold
    expect(writeCandidates.length + readCandidates.length).toBe(0);
  });

  it("generates command names with verb prefix for write candidates", () => {
    const reqs: RecordedRequest[] = [
      {
        url: "https://api.example.com/api/comments",
        data: { id: 1 },
        ts: 1,
        method: "POST",
      },
      {
        url: "https://api.example.com/api/comments/1",
        data: null,
        ts: 2,
        method: "DELETE",
      },
    ];
    const { writeCandidates } = analyzeRequests(reqs);
    const names = writeCandidates.map((c) => c.name);
    expect(names.some((n) => n.startsWith("create-"))).toBe(true);
    expect(names.some((n) => n.startsWith("delete-"))).toBe(true);
  });

  it("returns empty arrays when no requests match thresholds", () => {
    const { readCandidates, writeCandidates } = analyzeRequests([]);
    expect(readCandidates).toHaveLength(0);
    expect(writeCandidates).toHaveLength(0);
  });
});

// ── buildWriteCandidateYaml ────────────────────────────────────────────────────

describe("buildWriteCandidateYaml", () => {
  const baseCandidate: ScoredCandidate = {
    name: "create-item",
    url: "https://api.example.com/api/v1/items",
    score: 5,
    isWrite: true,
    responsePreview: { id: 1 },
    method: "POST",
  };

  it("generates valid YAML with required fields", () => {
    const yaml = buildWriteCandidateYaml("example", baseCandidate, "https://example.com");
    expect(yaml).toContain("site: example");
    expect(yaml).toContain("name: create-item");
    expect(yaml).toContain("type: web-api");
    expect(yaml).toContain("strategy: cookie");
    expect(yaml).toContain("method: POST");
  });

  it("includes Content-Type header for POST", () => {
    const yaml = buildWriteCandidateYaml("example", baseCandidate, "https://example.com");
    expect(yaml).toContain("Content-Type: application/json");
  });

  it("includes body template for POST (not DELETE)", () => {
    const yaml = buildWriteCandidateYaml("example", baseCandidate, "https://example.com");
    expect(yaml).toContain('${{ args.body | default("{}") }}');
  });

  it("does NOT include body template for DELETE", () => {
    const deleteCandidate: ScoredCandidate = {
      ...baseCandidate,
      name: "delete-item",
      method: "DELETE",
    };
    const yaml = buildWriteCandidateYaml("example", deleteCandidate, "https://example.com");
    expect(yaml).toContain("method: DELETE");
    expect(yaml).not.toContain('${{ args.body');
  });

  it("templatizes URL query params in the YAML", () => {
    const candidateWithParams: ScoredCandidate = {
      ...baseCandidate,
      url: "https://api.example.com/api/items?type=post",
    };
    const yaml = buildWriteCandidateYaml("example", candidateWithParams, "https://example.com");
    expect(yaml).toContain('${{ args.type | default("") }}');
  });

  it("includes the domain", () => {
    const yaml = buildWriteCandidateYaml("example", baseCandidate, "https://example.com");
    expect(yaml).toContain("domain: api.example.com");
  });

  it("handles PUT method correctly", () => {
    const putCandidate: ScoredCandidate = {
      ...baseCandidate,
      name: "update-item",
      method: "PUT",
    };
    const yaml = buildWriteCandidateYaml("example", putCandidate, "https://example.com");
    expect(yaml).toContain("method: PUT");
    expect(yaml).toContain('${{ args.body | default("{}") }}');
  });
});
