import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../../src/browser/cdp-client.js");
  vi.doUnmock("../../src/browser/bridge.js");
  vi.resetModules();
});

describe("cookie extraction", () => {
  it("uses a broker-owned target when no explicit CDP port is requested", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const sendCDP = vi.fn().mockResolvedValue({
      cookies: [
        {
          name: "sid",
          value: "broker-secret",
          domain: ".example.com",
          path: "/",
          expires: 0,
          httpOnly: true,
          secure: true,
        },
      ],
    });
    vi.doMock("../../src/browser/bridge.js", () => ({
      BrowserBridge: class {
        async connect() {
          return { sendCDP, close };
        }
      },
    }));
    const { extractCookiesViaCDP } =
      await import("../../src/engine/cookie-extractor.js");

    await expect(extractCookiesViaCDP("example.com")).resolves.toEqual({
      sid: "broker-secret",
    });
    expect(sendCDP).toHaveBeenCalledWith("Network.getCookies", {
      urls: [
        "https://example.com",
        "https://www.example.com",
        "http://example.com",
        "http://www.example.com",
      ],
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects when CDP is unavailable without creating storage", async () => {
    const { extractCookiesViaCDP } =
      await import("../../src/engine/cookie-extractor.js");
    await expect(extractCookiesViaCDP("example.com", 19999)).rejects.toThrow();
  });

  it("surfaces CDP cleanup failure after a successful cookie read", async () => {
    vi.doMock("../../src/browser/cdp-client.js", () => ({
      resolveCdpPort: () => 9222,
      CDPClient: {
        connectToChrome: async () => ({
          send: async () => ({
            cookies: [
              {
                name: "sid",
                value: "secret",
                domain: ".example.com",
                path: "/",
                expires: 0,
                httpOnly: true,
                secure: true,
              },
            ],
          }),
          close: async () => {
            throw new Error("close failed");
          },
        }),
      },
    }));
    const { extractCookiesViaCDP } =
      await import("../../src/engine/cookie-extractor.js");

    await expect(extractCookiesViaCDP("example.com", 9222)).rejects.toThrow(
      "close failed",
    );
  });

  it("preserves both cookie-read and cleanup failures", async () => {
    vi.doMock("../../src/browser/cdp-client.js", () => ({
      resolveCdpPort: () => 9222,
      CDPClient: {
        connectToChrome: async () => ({
          send: async () => {
            throw new Error("read failed");
          },
          close: async () => {
            throw new Error("close failed");
          },
        }),
      },
    }));
    const { extractCookiesViaCDP } =
      await import("../../src/engine/cookie-extractor.js");

    const result = extractCookiesViaCDP("example.com", 9222);
    await expect(result).rejects.toThrow(
      "Cookie extraction and CDP cleanup both failed",
    );
    await expect(result).rejects.toBeInstanceOf(AggregateError);
  });
});
