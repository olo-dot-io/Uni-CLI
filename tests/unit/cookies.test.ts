import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Temp cookie dir for isolation
const TEST_COOKIE_DIR = join(tmpdir(), `unicli-cookie-test-${Date.now()}`);

// Override cookie dir before importing the module
process.env.UNICLI_COOKIE_DIR = TEST_COOKIE_DIR;

import {
  loadCookies,
  formatCookieHeader,
  validateCookies,
  getCookieDir,
  refreshCookiesFromBrowser,
  acquireCookies,
  forgetTransientCookies,
} from "../../src/engine/cookies.js";
import type { CookieSources } from "../../src/engine/cookie-source.js";

beforeAll(() => {
  mkdirSync(TEST_COOKIE_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_COOKIE_DIR, { recursive: true, force: true });
  delete process.env.UNICLI_COOKIE_DIR;
});

describe("loadCookies", () => {
  it("returns null when cookie file does not exist", () => {
    const result = loadCookies("nonexistent");
    expect(result).toBeNull();
  });

  it("loads cookies from JSON file", () => {
    writeFileSync(
      join(TEST_COOKIE_DIR, "bilibili.json"),
      JSON.stringify({ SESSDATA: "abc123", bili_jct: "def456" }),
    );
    const result = loadCookies("bilibili");
    expect(result).not.toBeNull();
    expect(result!.SESSDATA).toBe("abc123");
    expect(result!.bili_jct).toBe("def456");
  });

  it("returns null for malformed JSON", () => {
    writeFileSync(join(TEST_COOKIE_DIR, "broken.json"), "not json{{{");
    const result = loadCookies("broken");
    expect(result).toBeNull();
  });

  it("returns null for array JSON", () => {
    writeFileSync(join(TEST_COOKIE_DIR, "array.json"), JSON.stringify(["a"]));
    const result = loadCookies("array");
    expect(result).toBeNull();
  });
});

describe("formatCookieHeader", () => {
  it("formats cookies as header string", () => {
    const header = formatCookieHeader({ SESSDATA: "abc", bili_jct: "def" });
    expect(header).toBe("SESSDATA=abc; bili_jct=def");
  });

  it("handles single cookie", () => {
    const header = formatCookieHeader({ z_c0: "token123" });
    expect(header).toBe("z_c0=token123");
  });

  it("handles empty cookies", () => {
    const header = formatCookieHeader({});
    expect(header).toBe("");
  });
});

describe("validateCookies", () => {
  it("returns valid when all required keys present", () => {
    writeFileSync(
      join(TEST_COOKIE_DIR, "complete.json"),
      JSON.stringify({ key1: "val1", key2: "val2" }),
    );
    const result = validateCookies("complete", ["key1", "key2"]);
    expect(result.valid).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("returns invalid with missing keys", () => {
    writeFileSync(
      join(TEST_COOKIE_DIR, "partial.json"),
      JSON.stringify({ key1: "val1" }),
    );
    const result = validateCookies("partial", ["key1", "key2"]);
    expect(result.valid).toBe(false);
    expect(result.missing).toEqual(["key2"]);
  });

  it("returns invalid when file does not exist", () => {
    const result = validateCookies("missing_site", ["key1"]);
    expect(result.valid).toBe(false);
    expect(result.missing).toEqual(["key1"]);
  });
});

describe("getCookieDir", () => {
  it("returns the cookie directory path", () => {
    const dir = getCookieDir();
    expect(dir).toBe(TEST_COOKIE_DIR);
  });
});

describe("refreshCookiesFromBrowser", () => {
  afterEach(() => {
    forgetTransientCookies("example", "example.com");
  });

  it("rejects invalid site names before touching browser state", async () => {
    const result = await refreshCookiesFromBrowser("../bad", "example.com");
    expect(result).toMatchObject({
      ok: false,
      site: "../bad",
      domain: "example.com",
    });
    expect(result.suggestion).toContain("Site names");
  });

  it("hands fresh browser cookies to the immediate retry instead of stale disk state", async () => {
    const refreshSources: CookieSources = {
      readDisk: () => ({ kind: "ok", cookies: { sid: "stale" } }),
      readBrowser: async () => ({
        kind: "ok",
        cookies: { sid: "fresh" },
      }),
      readCdp: async () => ({}),
    };
    const retrySources: CookieSources = {
      readDisk: () => ({ kind: "ok", cookies: { sid: "stale" } }),
      readBrowser: async () => ({ kind: "none" }),
      readCdp: async () => ({}),
    };

    const refresh = await refreshCookiesFromBrowser(
      "example",
      "example.com",
      {},
      refreshSources,
    );
    const retry = await acquireCookies(
      "example",
      "example.com",
      {},
      retrySources,
    );

    expect(refresh).toMatchObject({ ok: true, source: "browser" });
    expect(retry).toEqual({
      status: "loaded",
      source: "browser",
      cookies: { sid: "fresh" },
    });
  });
});

describe("live cookie acquisition", () => {
  it("keeps browser cookies in memory unless the user explicitly imports", async () => {
    const sources: CookieSources = {
      readDisk: () => ({ kind: "absent" }),
      readBrowser: async () => ({
        kind: "ok",
        cookies: { sid: "memory-only" },
      }),
      readCdp: async () => ({}),
    };

    const outcome = await acquireCookies(
      "memory-only",
      "example.com",
      {},
      sources,
    );

    expect(outcome).toEqual({
      status: "loaded",
      source: "browser",
      cookies: { sid: "memory-only" },
    });
    expect(existsSync(join(TEST_COOKIE_DIR, "memory-only.json"))).toBe(false);
  });
});
