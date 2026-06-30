import { afterEach, describe, expect, it, vi } from "vitest";

import {
  describeCookieFailure,
  loadCookiesWithDiagnostics,
  type BrowserAttempt,
  type CookieSources,
  type DiskRead,
} from "../../../src/engine/cookie-source.js";

// Fully injected sources — no fs, no Keychain, no browser, no network.
function sources(over: Partial<CookieSources>): CookieSources {
  return {
    readDisk: (): DiskRead => ({ kind: "absent" }),
    readBrowser: async (): Promise<BrowserAttempt> => ({ kind: "none" }),
    readCdp: async () => ({}),
    ...over,
  };
}

const prevNoBrowser = process.env.UNICLI_COOKIE_NO_BROWSER;
afterEach(() => {
  if (prevNoBrowser === undefined) delete process.env.UNICLI_COOKIE_NO_BROWSER;
  else process.env.UNICLI_COOKIE_NO_BROWSER = prevNoBrowser;
  vi.doUnmock("../../../src/browser/local-profiles.js");
  vi.doUnmock("../../../src/engine/chromium-cookies.js");
  vi.resetModules();
});

describe("loadCookiesWithDiagnostics — surfaces the real cause, never silent null", () => {
  it("returns loaded from disk when the file is present", async () => {
    const out = await loadCookiesWithDiagnostics(
      "bilibili",
      undefined,
      sources({ readDisk: () => ({ kind: "ok", cookies: { a: "1" } }) }),
    );
    expect(out).toEqual({
      status: "loaded",
      source: "disk",
      cookies: { a: "1" },
    });
  });

  it("falls through disk→browser→cdp and reports the loading source", async () => {
    const out = await loadCookiesWithDiagnostics(
      "x",
      "x.com",
      sources({
        readBrowser: async () => ({ kind: "none" }),
        readCdp: async () => ({ s: "v" }),
      }),
    );
    expect(out).toEqual({
      status: "loaded",
      source: "cdp",
      cookies: { s: "v" },
    });
  });

  it("reports ABSENT (not error) when nothing is logged in and nothing errored", async () => {
    const out = await loadCookiesWithDiagnostics("x", "x.com", sources({}));
    expect(out).toEqual({ status: "absent" });
  });

  it("reports ERROR with the keychain reason instead of collapsing to null", async () => {
    const out = await loadCookiesWithDiagnostics(
      "x",
      "x.com",
      sources({
        readBrowser: async () => ({
          kind: "error",
          reasons: [
            { source: "browser", code: "keychain_denied", detail: "denied" },
          ],
        }),
      }),
    );
    expect(out.status).toBe("error");
    if (out.status !== "error") throw new Error("unreachable");
    expect(out.reasons.map((r) => r.code)).toContain("keychain_denied");
  });

  it("accumulates a corrupt-disk reason together with a cdp failure", async () => {
    const out = await loadCookiesWithDiagnostics(
      "x",
      "x.com",
      sources({
        readDisk: () => ({ kind: "corrupt", detail: "bad json" }),
        readCdp: async () => {
          throw new Error("ECONNREFUSED 9222");
        },
      }),
    );
    expect(out.status).toBe("error");
    if (out.status !== "error") throw new Error("unreachable");
    expect(out.reasons.map((r) => r.code).sort()).toEqual([
      "cdp_unavailable",
      "corrupt_file",
    ]);
  });

  it("a corrupt disk file does NOT mask a successful browser load", async () => {
    const out = await loadCookiesWithDiagnostics(
      "x",
      "x.com",
      sources({
        readDisk: () => ({ kind: "corrupt", detail: "bad" }),
        readBrowser: async () => ({ kind: "ok", cookies: { b: "2" } }),
      }),
    );
    expect(out).toEqual({
      status: "loaded",
      source: "browser",
      cookies: { b: "2" },
    });
  });

  it("honors UNICLI_COOKIE_NO_BROWSER=1 by skipping the browser source", async () => {
    process.env.UNICLI_COOKIE_NO_BROWSER = "1";
    let browserCalled = false;
    const out = await loadCookiesWithDiagnostics(
      "x",
      "x.com",
      sources({
        readBrowser: async () => {
          browserCalled = true;
          return { kind: "ok", cookies: { skip: "me" } };
        },
        readCdp: async () => ({ via: "cdp" }),
      }),
    );
    expect(browserCalled).toBe(false);
    expect(out).toEqual({
      status: "loaded",
      source: "cdp",
      cookies: { via: "cdp" },
    });
  });
});

describe("describeCookieFailure — distinct, actionable guidance per cause", () => {
  it("absent → sign-in guidance", () => {
    const d = describeCookieFailure({ status: "absent" }, "bilibili");
    expect(d.message).toContain("No cookies found");
    expect(d.suggestion).toContain("auth import bilibili");
  });

  it("keychain_denied → Keychain-specific guidance, not generic", () => {
    const d = describeCookieFailure(
      {
        status: "error",
        reasons: [{ source: "browser", code: "keychain_denied", detail: "x" }],
      },
      "x",
      "x.com",
    );
    expect(d.suggestion).toMatch(/Keychain/i);
    expect(d.message).toContain("keychain_denied");
  });

  it("encryption_unsupported (v20) → CDP-path guidance", () => {
    const d = describeCookieFailure(
      {
        status: "error",
        reasons: [
          { source: "browser", code: "encryption_unsupported", detail: "v20" },
        ],
      },
      "x",
    );
    expect(d.suggestion).toMatch(/v20|app-bound|CDP/i);
  });

  it("corrupt_file → re-import guidance", () => {
    const d = describeCookieFailure(
      {
        status: "error",
        reasons: [{ source: "disk", code: "corrupt_file", detail: "bad json" }],
      },
      "x",
    );
    expect(d.suggestion).toMatch(/unreadable|Re-import/i);
  });
});

describe("default browser cookie source", () => {
  it("tries the preferred local browser profile before installed-browser fallback", async () => {
    vi.resetModules();
    const readCookiesAsRecord = vi.fn().mockReturnValue({ sid: "preferred" });
    const detectInstalledBrowsers = vi.fn().mockReturnValue(["chrome"]);
    vi.doMock("../../../src/engine/chromium-cookies.js", () => {
      class ChromiumCookieError extends Error {
        readonly code = "no_profile";
      }
      return {
        ChromiumCookieError,
        readCookiesAsRecord,
        detectInstalledBrowsers,
      };
    });
    vi.doMock("../../../src/browser/local-profiles.js", () => ({
      browserCookieIdForLocalProfile: vi.fn(() => "chrome"),
      resolvePreferredLocalBrowserProfile: vi.fn(() => ({
        browser_name: "Google Chrome",
        user_data_dir: "/Users/me/Library/Application Support/Google/Chrome",
        profile_dir: "Default",
        display_name: "Google Chrome - Me",
      })),
    }));

    const mod = await import("../../../src/engine/cookie-source.js");
    const out = await mod.defaultCookieSources.readBrowser("example.com");

    expect(out).toEqual({ kind: "ok", cookies: { sid: "preferred" } });
    expect(readCookiesAsRecord).toHaveBeenCalledWith({
      browser: "chrome",
      domain: "example.com",
      profile: "Default",
      userDataDir: "/Users/me/Library/Application Support/Google/Chrome",
    });
    expect(detectInstalledBrowsers).not.toHaveBeenCalled();
  });
});
