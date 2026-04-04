import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
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
} from "../../src/engine/cookies.js";

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
