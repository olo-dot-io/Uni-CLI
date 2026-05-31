import { afterEach, describe, expect, it, vi } from "vitest";

import {
  refreshCookies,
  type PageSession,
  type SessionRefreshDeps,
} from "../../../src/engine/cookie-refresh.js";
import { resolveCdpPort } from "../../../src/browser/cdp-client.js";

// A fully fake page — no Chrome, no CDP, no network.
function fakePage(over: Partial<PageSession> = {}): PageSession {
  return {
    goto: async () => {},
    cookies: async () => ({ SESSDATA: "abc" }),
    close: async () => {},
    ...over,
  };
}

function deps(over: Partial<SessionRefreshDeps> = {}): SessionRefreshDeps {
  return {
    connect: async () => fakePage(),
    persist: () => {},
    ...over,
  };
}

describe("refreshCookies — names the cause instead of a bare boolean", () => {
  it("returns refreshed with a cookie count and persists on success", async () => {
    const persisted: Array<[string, Record<string, string>]> = [];
    const out = await refreshCookies(
      "bilibili",
      undefined,
      deps({
        connect: async () =>
          fakePage({ cookies: async () => ({ a: "1", b: "2" }) }),
        persist: (site, cookies) => persisted.push([site, cookies]),
      }),
    );
    expect(out).toEqual({
      status: "refreshed",
      site: "bilibili",
      cookieCount: 2,
    });
    expect(persisted).toEqual([["bilibili", { a: "1", b: "2" }]]);
  });

  it("returns no-browser (not false) when the connection fails", async () => {
    const out = await refreshCookies(
      "x",
      "x.com",
      deps({
        connect: async () => {
          throw new Error("ECONNREFUSED 9222");
        },
      }),
    );
    expect(out.status).toBe("no-browser");
    if (out.status !== "no-browser") throw new Error("unreachable");
    expect(out.detail).toContain("ECONNREFUSED");
  });

  it("returns no-cookies when navigation yields an empty jar", async () => {
    const out = await refreshCookies(
      "x",
      "x.com",
      deps({ connect: async () => fakePage({ cookies: async () => ({}) }) }),
    );
    expect(out.status).toBe("no-cookies");
  });

  it("returns error when navigation throws, and does not persist", async () => {
    const persist = vi.fn();
    const out = await refreshCookies(
      "x",
      "x.com",
      deps({
        connect: async () =>
          fakePage({
            goto: async () => {
              throw new Error("navigation timeout");
            },
          }),
        persist,
      }),
    );
    expect(out.status).toBe("error");
    if (out.status !== "error") throw new Error("unreachable");
    expect(out.detail).toContain("navigation timeout");
    expect(persist).not.toHaveBeenCalled();
  });

  it("always closes the page, even when the refresh errors", async () => {
    const close = vi.fn(async () => {});
    await refreshCookies(
      "x",
      "x.com",
      deps({
        connect: async () =>
          fakePage({
            close,
            cookies: async () => {
              throw new Error("read failed");
            },
          }),
      }),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("a close failure does not override the determined outcome", async () => {
    const out = await refreshCookies(
      "x",
      "x.com",
      deps({
        connect: async () =>
          fakePage({
            cookies: async () => ({ ok: "1" }),
            close: async () => {
              throw new Error("close blew up");
            },
          }),
      }),
    );
    expect(out.status).toBe("refreshed");
  });
});

describe("resolveCdpPort — one consistent semantic for every caller", () => {
  const prev = process.env.UNICLI_CDP_PORT;
  afterEach(() => {
    if (prev === undefined) delete process.env.UNICLI_CDP_PORT;
    else process.env.UNICLI_CDP_PORT = prev;
  });

  it("an explicit port wins over the environment", () => {
    process.env.UNICLI_CDP_PORT = "3000";
    expect(resolveCdpPort(4567)).toBe(4567);
  });

  it("uses a valid environment port", () => {
    process.env.UNICLI_CDP_PORT = "9333";
    expect(resolveCdpPort()).toBe(9333);
  });

  it("defaults to 9222 when no environment port is set", () => {
    delete process.env.UNICLI_CDP_PORT;
    expect(resolveCdpPort()).toBe(9222);
  });

  it("THROWS on a malformed port instead of silently falling back", () => {
    process.env.UNICLI_CDP_PORT = "not-a-port";
    expect(() => resolveCdpPort()).toThrow(/Invalid UNICLI_CDP_PORT/);
  });

  it("THROWS on an out-of-range port", () => {
    process.env.UNICLI_CDP_PORT = "70000";
    expect(() => resolveCdpPort()).toThrow(/Invalid UNICLI_CDP_PORT/);
  });
});
