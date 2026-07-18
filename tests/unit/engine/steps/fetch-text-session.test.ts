import { afterEach, describe, expect, it } from "vitest";

import {
  fetchTextResource,
  stepFetchText,
} from "../../../../src/engine/steps/fetch-text.js";

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
  it.each([
    "application/yaml",
    "application/x-yaml",
    "application/toml",
    "application/x-ndjson",
    "application/json-seq",
  ])("accepts structured textual MIME type %s", async (contentType) => {
    mockOnce(
      () =>
        new Response("name: model", {
          status: 200,
          headers: { "content-type": contentType },
        }),
    );

    const out = await stepFetchText(ctx(), {
      url: "https://example.com/manifest",
    });

    expect(out.data).toBe("name: model");
  });

  it.each([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/epub+zip",
    "application/wasm",
    "application/x-protobuf",
  ])("rejects non-text MIME type %s", async (contentType) => {
    mockOnce(
      () =>
        new Response("binary", {
          status: 200,
          headers: { "content-type": contentType },
        }),
    );

    await expect(
      stepFetchText(ctx(), { url: "https://example.com/artifact" }),
    ).rejects.toMatchObject({
      detail: expect.objectContaining({
        errorType: "unsupported_content_type",
      }),
    });
  });

  it("rejects a declared PDF before binary bytes enter text pipelines", async () => {
    mockOnce(
      () =>
        new Response("%PDF-1.7 binary", {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
    );

    await expect(
      stepFetchText(ctx(), { url: "https://example.com/manual.pdf" }),
    ).rejects.toMatchObject({
      detail: expect.objectContaining({
        errorType: "unsupported_content_type",
        preserveErrorCode: true,
      }),
    });
  });

  it("rejects PDF magic bytes when a server lies about the MIME type", async () => {
    mockOnce(
      () =>
        new Response("%PDF-1.7 binary", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );

    await expect(
      stepFetchText(ctx(), { url: "https://example.com/download" }),
    ).rejects.toMatchObject({
      detail: expect.objectContaining({
        errorType: "unsupported_content_type",
      }),
    });
  });

  it("rejects recognizable binary magic when the server omits MIME", async () => {
    mockOnce(
      () =>
        new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]), {
          status: 200,
        }),
    );

    await expect(
      stepFetchText(ctx(), { url: "https://example.com/download" }),
    ).rejects.toMatchObject({
      detail: expect.objectContaining({
        errorType: "unsupported_content_type",
      }),
    });
  });

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
    mockOnce((url) =>
      url === "https://kyfw.12306.cn/otn/leftTicket/init"
        ? new Response(null, {
            status: 302,
            headers: { location: "https://evil.example.com/landing" },
          })
        : new Response("body", {
            status: 200,
            headers: [["set-cookie", "evil=1; Path=/"]],
          }),
    );
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

describe("fetch_text validated redirects", () => {
  it("rejects reserved addresses at the exported fetch boundary", async () => {
    const previousAllowLocal = process.env.UNICLI_ALLOW_LOCAL;
    delete process.env.UNICLI_ALLOW_LOCAL;
    const calls = mockOnce(() => new Response("must not execute"));
    try {
      await expect(
        fetchTextResource(
          "http://127.0.0.1:8080/internal",
          { url: "http://127.0.0.1:8080/internal" },
          {},
          0,
        ),
      ).rejects.toThrow(/blocked fetch to reserved\/local address/);
      expect(calls).toHaveLength(0);
    } finally {
      if (previousAllowLocal === undefined) {
        delete process.env.UNICLI_ALLOW_LOCAL;
      } else {
        process.env.UNICLI_ALLOW_LOCAL = previousAllowLocal;
      }
    }
  });

  it("rejects a public redirect before contacting its reserved target", async () => {
    const previousAllowLocal = process.env.UNICLI_ALLOW_LOCAL;
    delete process.env.UNICLI_ALLOW_LOCAL;
    const calls = mockOnce(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1:8080/internal" },
        }),
    );
    try {
      await expect(
        fetchTextResource(
          "https://example.com/redirect",
          { url: "https://example.com/redirect" },
          {},
          0,
        ),
      ).rejects.toThrow(/blocked fetch to reserved\/local address/);
      expect(calls).toHaveLength(1);
    } finally {
      if (previousAllowLocal === undefined) {
        delete process.env.UNICLI_ALLOW_LOCAL;
      } else {
        process.env.UNICLI_ALLOW_LOCAL = previousAllowLocal;
      }
    }
  });

  it("strips credentials across origins and reports the validated final URL", async () => {
    const calls = mockOnce((url) =>
      url === "https://example.com/start"
        ? new Response(null, {
            status: 302,
            headers: { location: "https://example.org/final" },
          })
        : new Response("public body", { status: 200 }),
    );

    const resource = await fetchTextResource(
      "https://example.com/start",
      { url: "https://example.com/start" },
      { Authorization: "Bearer secret", Cookie: "session=secret" },
      0,
    );

    const redirectedHeaders = new Headers(calls[1]?.init.headers);
    expect(resource.finalUrl).toBe("https://example.org/final");
    expect(redirectedHeaders.has("authorization")).toBe(false);
    expect(redirectedHeaders.has("cookie")).toBe(false);
  });

  it("preserves the caller cancellation reason instead of making it retryable", async () => {
    const controller = new AbortController();
    const reason = new Error("caller-cancelled");
    globalThis.fetch = (async (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          {
            once: true,
          },
        );
      })) as unknown as typeof fetch;

    const pending = fetchTextResource(
      "https://example.com/slow",
      { url: "https://example.com/slow" },
      {},
      0,
      { signal: controller.signal },
    );
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
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
