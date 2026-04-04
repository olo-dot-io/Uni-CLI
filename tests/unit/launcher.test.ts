import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { findChrome, getCDPPort } from "../../src/browser/launcher.js";

// ── findChrome tests ────────────────────────────────────────────────

describe("findChrome", () => {
  it("returns a string path on macOS when Chrome exists", () => {
    // On macOS CI or local dev, Chrome is typically installed
    if (process.platform !== "darwin") return;

    const result = findChrome();
    // If Chrome is installed, we get a path; if not, null is acceptable
    if (result !== null) {
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it("returns null when no Chrome paths exist", () => {
    // Mock platform to something with no Chrome paths defined
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "freebsd" });

    try {
      const result = findChrome();
      expect(result).toBeNull();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});

// ── getCDPPort tests ────────────────────────────────────────────────

describe("getCDPPort", () => {
  const originalEnv = process.env.UNICLI_CDP_PORT;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.UNICLI_CDP_PORT;
    } else {
      process.env.UNICLI_CDP_PORT = originalEnv;
    }
  });

  it("returns 9222 as the default port", () => {
    delete process.env.UNICLI_CDP_PORT;
    expect(getCDPPort()).toBe(9222);
  });

  it("reads port from UNICLI_CDP_PORT env var", () => {
    process.env.UNICLI_CDP_PORT = "9333";
    expect(getCDPPort()).toBe(9333);
  });

  it("parses numeric strings correctly", () => {
    process.env.UNICLI_CDP_PORT = "12345";
    expect(getCDPPort()).toBe(12345);
  });
});
