import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OpenReviewHttpClient,
  openReviewCookieHeader,
  readOpenReviewContent,
  resetOpenReviewRequestSchedulerForTests,
  retryAfterMilliseconds,
} from "./client.js";

afterEach(() => {
  resetOpenReviewRequestSchedulerForTests();
  vi.restoreAllMocks();
});

describe("OpenReview authenticated paced client", () => {
  it("allowlists access and clearance cookies but never refresh tokens", () => {
    expect(
      openReviewCookieHeader({
        "openreview.accessToken": "access",
        "openreview.clearanceToken": "clearance",
        "openreview.refreshToken": "refresh",
        unrelated: "value",
      }),
    ).toBe(
      "openreview.accessToken=access; openreview.clearanceToken=clearance",
    );
  });

  it("reads both v2 wrapped content and legacy v1 values", () => {
    expect(readOpenReviewContent({ title: { value: "v2" } }, "title")).toBe(
      "v2",
    );
    expect(readOpenReviewContent({ title: "v1" }, "title")).toBe("v1");
  });

  it("parses delta seconds and HTTP-date Retry-After values", () => {
    expect(retryAfterMilliseconds("2", 0)).toBe(2000);
    expect(retryAfterMilliseconds("Thu, 01 Jan 1970 00:00:03 GMT", 1000)).toBe(
      2000,
    );
    expect(retryAfterMilliseconds("invalid", 0)).toBeUndefined();
  });

  it("uses browser-derived access state and retries 429 after Retry-After", async () => {
    const calls: Array<Record<string, string>> = [];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (_url, init) => {
        calls.push(init?.headers as Record<string, string>);
        return new Response('{"name":"RateLimitError"}', {
          status: 429,
          headers: { "retry-after": "2" },
        });
      })
      .mockImplementationOnce(async (_url, init) => {
        calls.push(init?.headers as Record<string, string>);
        return new Response('{"notes":[]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
    const sleeps: number[] = [];
    const client = new OpenReviewHttpClient({
      fetcher,
      rpm: 180,
      maxRetries: 1,
      random: () => 0,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      loadCookies: async () => ({
        "openreview.accessToken": "token",
        "openreview.refreshToken": "never-send",
      }),
    });

    await expect(client.json("/notes?id=abc", "test note")).resolves.toEqual({
      notes: [],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(calls[0].Authorization).toBe("Bearer token");
    expect(calls[0].Cookie).toBe("openreview.accessToken=token");
    expect(calls[0].Cookie).not.toContain("refresh");
    expect(sleeps).toContain(2000);
  });

  it("surfaces expired browser tokens as auth_required", async () => {
    const client = new OpenReviewHttpClient({
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            '{"name":"TokenExpiredError","message":"token expired"}',
            { status: 401 },
          ),
        ),
      rpm: 180,
      sleep: async () => undefined,
      loadCookies: async () => ({ "openreview.accessToken": "expired" }),
    });
    await expect(client.json("/groups?id=x", "group x")).rejects.toMatchObject({
      code: "auth_required",
      retryable: false,
    });
  });

  it("refreshes an expired browser session once and reuses it in memory", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string>;
      seen.push({ url, headers });
      if (url.endsWith("/refreshToken")) {
        return new Response('{"token":"fresh"}', { status: 200 });
      }
      if (headers.Authorization === "Bearer stale") {
        return new Response(
          '{"name":"TokenExpiredError","message":"expired"}',
          { status: 401 },
        );
      }
      return new Response('{"groups":[{"id":"V"}]}', { status: 200 });
    });
    const loadCookies = vi.fn(async () => ({
      "openreview.accessToken": "stale",
      "openreview.refreshToken": "refresh-secret",
    }));
    const client = new OpenReviewHttpClient({
      fetcher,
      rpm: 180,
      sleep: async () => undefined,
      loadCookies,
    });

    await expect(client.json("/groups?id=V", "group V")).resolves.toEqual({
      groups: [{ id: "V" }],
    });
    await expect(client.json("/groups?id=W", "group W")).resolves.toEqual({
      groups: [{ id: "V" }],
    });
    expect(loadCookies).toHaveBeenCalledTimes(1);
    expect(
      seen.filter((call) => call.url.endsWith("/refreshToken")),
    ).toHaveLength(1);
    const refreshCall = seen.find((call) => call.url.endsWith("/refreshToken"));
    expect(refreshCall?.headers.Cookie).toBe(
      "openreview.refreshToken=refresh-secret",
    );
    expect(
      seen.filter((call) => call.headers.Authorization === "Bearer fresh"),
    ).toHaveLength(2);
  });
});
