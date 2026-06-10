import { afterEach, describe, expect, it } from "vitest";

import { stepFetchText } from "../../../../src/engine/steps/fetch-text.js";

const ctx = (over: Record<string, unknown> = {}) => ({
  data: null,
  args: {},
  vars: {},
  ...over,
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockOnce(handler: (url: string, init: RequestInit) => Response): {
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return calls;
}

describe("fetch_text capture_cookies", () => {
  it("resolves header templates before sending the request", async () => {
    const previousToken = process.env.UNICLI_TEST_TEXT_AUTH;
    process.env.UNICLI_TEST_TEXT_AUTH = "unit-text-token";
    try {
      const calls = mockOnce(
        () =>
          new Response("body", {
            status: 200,
          }),
      );
      await stepFetchText(ctx({ args: { q: "markdown" } }), {
        url: "https://example.com/article",
        headers: {
          Authorization: "Bearer ${{ env.UNICLI_TEST_TEXT_AUTH || '' }}",
          "X-Query": "${{ args.q }}",
        },
      });

      expect(calls[0]?.init.headers).toMatchObject({
        Authorization: "Bearer unit-text-token",
        "X-Query": "markdown",
      });
    } finally {
      if (previousToken === undefined) {
        delete process.env.UNICLI_TEST_TEXT_AUTH;
      } else {
        process.env.UNICLI_TEST_TEXT_AUTH = previousToken;
      }
    }
  });

  it("merges response Set-Cookie into returned ctx.cookieHeader (same host)", async () => {
    mockOnce(
      () =>
        new Response("body", {
          status: 200,
          headers: [
            ["set-cookie", "JSESSIONID=abc; Path=/otn; HttpOnly"],
            ["set-cookie", "route=xyz; Path=/"],
          ],
        }),
    );
    const out = await stepFetchText(ctx(), {
      url: "https://kyfw.12306.cn/otn/leftTicket/init",
      capture_cookies: true,
    });
    expect(out.cookieHeader).toBe("JSESSIONID=abc; route=xyz");
    expect(out.data).toBe("body");
  });

  it("does NOT capture cookies from a cross-site final URL (leak guard)", async () => {
    mockOnce(() => {
      const r = new Response("body", {
        status: 200,
        headers: [["set-cookie", "evil=1; Path=/"]],
      });
      Object.defineProperty(r, "url", {
        value: "https://evil.example.com/landing",
      });
      return r;
    });
    const out = await stepFetchText(ctx(), {
      url: "https://kyfw.12306.cn/otn/leftTicket/init",
      capture_cookies: true,
    });
    expect(out.cookieHeader).toBeUndefined();
  });

  it("leaves cookieHeader untouched when capture_cookies is off", async () => {
    mockOnce(
      () =>
        new Response("body", {
          status: 200,
          headers: [["set-cookie", "a=1"]],
        }),
    );
    const out = await stepFetchText(ctx(), {
      url: "https://kyfw.12306.cn/otn/x",
    });
    expect(out.cookieHeader).toBeUndefined();
  });
});

describe("fetch_text endpoint rotation", () => {
  it("advances to the next rotate_urls candidate when rotate_on_field appears", async () => {
    const calls = mockOnce((url) => {
      if (url.includes("queryG")) {
        return new Response(JSON.stringify({ c_url: "leftTicket/queryO" }), {
          status: 200,
        });
      }
      return new Response("a|1@b|2", { status: 200 });
    });
    const out = await stepFetchText(ctx(), {
      url: "https://kyfw.12306.cn/otn/leftTicket/queryG",
      rotate_urls: [
        "https://kyfw.12306.cn/otn/leftTicket/queryG",
        "https://kyfw.12306.cn/otn/leftTicket/queryO",
      ],
      rotate_on_field: "c_url",
    });
    expect(out.data).toBe("a|1@b|2");
    expect(calls.length).toBe(2);
    expect(calls[1]?.url).toContain("queryO");
  });

  it("returns the body when no rotation signal is present (first candidate wins)", async () => {
    const calls = mockOnce(() => new Response("ok|data", { status: 200 }));
    const out = await stepFetchText(ctx(), {
      url: "https://kyfw.12306.cn/otn/leftTicket/queryG",
      rotate_urls: [
        "https://kyfw.12306.cn/otn/leftTicket/queryG",
        "https://kyfw.12306.cn/otn/leftTicket/queryO",
      ],
      rotate_on_field: "c_url",
    });
    expect(out.data).toBe("ok|data");
    expect(calls.length).toBe(1);
  });

  it("stops after exhausting candidates and returns the last body (bounded)", async () => {
    const calls = mockOnce(
      () =>
        new Response(JSON.stringify({ c_url: "leftTicket/queryX" }), {
          status: 200,
        }),
    );
    const out = await stepFetchText(ctx(), {
      url: "https://kyfw.12306.cn/otn/leftTicket/queryG",
      rotate_urls: [
        "https://kyfw.12306.cn/otn/leftTicket/queryG",
        "https://kyfw.12306.cn/otn/leftTicket/queryO",
      ],
      rotate_on_field: "c_url",
    });
    // bounded by rotate_urls.length — never loops forever
    expect(calls.length).toBe(2);
    expect(typeof out.data).toBe("string");
  });
});
