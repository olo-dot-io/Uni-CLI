import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("cookie-extractor", () => {
  const testDir = join(tmpdir(), "unicli-cookie-test-" + Date.now());

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  it("extractCookiesViaCDP rejects when CDP is not available", async () => {
    const { extractCookiesViaCDP } = await import(
      "../../src/engine/cookie-extractor.js"
    );
    // Port 19999 should not have Chrome running
    await expect(extractCookiesViaCDP("example.com", 19999)).rejects.toThrow();
  });

  it("saveCookies writes JSON to disk", async () => {
    const { saveCookies } = await import(
      "../../src/engine/cookie-extractor.js"
    );
    // Override cookie dir via env
    const origDir = process.env.UNICLI_COOKIE_DIR;
    process.env.UNICLI_COOKIE_DIR = testDir;

    try {
      const cookies = { SESSDATA: "abc123", bili_jct: "def456" };
      const filePath = saveCookies("bilibili", cookies);

      expect(existsSync(filePath)).toBe(true);
      const saved = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(saved.SESSDATA).toBe("abc123");
      expect(saved.bili_jct).toBe("def456");
    } finally {
      process.env.UNICLI_COOKIE_DIR = origDir;
    }
  });

  it("saveCookies creates directory if it does not exist", async () => {
    const { saveCookies } = await import(
      "../../src/engine/cookie-extractor.js"
    );
    const nested = join(testDir, "deep", "nested");
    const origDir = process.env.UNICLI_COOKIE_DIR;
    process.env.UNICLI_COOKIE_DIR = nested;

    try {
      saveCookies("test-site", { key: "val" });
      expect(existsSync(join(nested, "test-site.json"))).toBe(true);
    } finally {
      process.env.UNICLI_COOKIE_DIR = origDir;
    }
  });

  it("saveCookies returns the file path", async () => {
    const { saveCookies } = await import(
      "../../src/engine/cookie-extractor.js"
    );
    const origDir = process.env.UNICLI_COOKIE_DIR;
    process.env.UNICLI_COOKIE_DIR = testDir;
    mkdirSync(testDir, { recursive: true });

    try {
      const path = saveCookies("example", { a: "1" });
      expect(path).toBe(join(testDir, "example.json"));
    } finally {
      process.env.UNICLI_COOKIE_DIR = origDir;
    }
  });
});
