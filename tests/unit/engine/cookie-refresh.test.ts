import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  refreshCookies,
  type PageSession,
  type SessionRefreshDeps,
} from "../../../src/engine/cookie-refresh.js";
import { forgetTransientCookies } from "../../../src/engine/cookies.js";
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
    ...over,
  };
}

describe("refreshCookies — names the cause instead of a bare boolean", () => {
  afterEach(() => {
    forgetTransientCookies("bilibili");
    forgetTransientCookies("x");
  });

  it("returns refreshed in memory without opting into persistence", async () => {
    const root = mkdtempSync(join(tmpdir(), "unicli-refresh-memory-"));
    const previous = process.env.UNICLI_COOKIE_DIR;
    process.env.UNICLI_COOKIE_DIR = join(root, "cookies");
    try {
      const out = await refreshCookies(
        "bilibili",
        undefined,
        deps({
          connect: async () =>
            fakePage({ cookies: async () => ({ a: "1", b: "2" }) }),
        }),
      );
      expect(out).toEqual({
        status: "refreshed",
        site: "bilibili",
        cookieCount: 2,
      });
      expect(existsSync(process.env.UNICLI_COOKIE_DIR)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.UNICLI_COOKIE_DIR;
      else process.env.UNICLI_COOKIE_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
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

  it("returns error when navigation throws", async () => {
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
      }),
    );
    expect(out.status).toBe("error");
    if (out.status !== "error") throw new Error("unreachable");
    expect(out.detail).toContain("navigation timeout");
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

  it("surfaces a close failure together with the determined outcome", async () => {
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
    expect(out).toEqual({
      status: "error",
      detail:
        "Cookie refresh reached refreshed, but CDP page cleanup failed: close blew up",
    });
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
