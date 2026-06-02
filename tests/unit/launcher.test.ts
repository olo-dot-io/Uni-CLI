import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "node:path";

const childProcessMocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  spawn: vi.fn(() => {
    const child = {
      unref: vi.fn(),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === "spawn") queueMicrotask(() => cb());
        return child;
      }),
    };
    return child;
  }),
}));

vi.mock("node:child_process", () => ({
  execSync: childProcessMocks.execSync,
  spawn: childProcessMocks.spawn,
}));

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

describe("launchChrome", () => {
  const originalChromePath = process.env.CHROME_PATH;

  function mockSpawnSuccess(): void {
    const child = {
      unref: vi.fn(),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === "spawn") queueMicrotask(() => cb());
        return child;
      }),
    };
    childProcessMocks.spawn.mockReturnValue(child);
  }

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mockSpawnSuccess();
    if (originalChromePath === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = originalChromePath;
  });

  it("starts headed Chrome without creating a foreground startup window by default", async () => {
    process.env.CHROME_PATH = "/Applications/Google Chrome.app/test";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new Error("not running"))
        .mockResolvedValue({ ok: true }),
    );

    const { launchChrome } = await import("../../src/browser/launcher.js");

    await expect(launchChrome(9444)).resolves.toBe(9444);
    const args = childProcessMocks.spawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain(
      `--user-data-dir=${join(process.env.HOME ?? "~", ".unicli", "chrome-profile")}`,
    );
    expect(args).toContain("--disable-extensions");
    expect(args).toContain("--no-startup-window");
    expect(args).not.toContain("--headless=new");
  });

  it("reports spawn errors instead of emitting an unhandled child_process error", async () => {
    process.env.CHROME_PATH = "/missing/chrome";
    const child = {
      unref: vi.fn(),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === "error") {
          queueMicrotask(() => cb(new Error("spawn ENOENT")));
        }
        return child;
      }),
    };
    childProcessMocks.spawn.mockReturnValueOnce(child);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("not running")));

    const { launchChrome } = await import("../../src/browser/launcher.js");

    await expect(launchChrome(9444)).rejects.toThrow(
      "Chrome launch failed: spawn ENOENT",
    );
  });

  it("allows an explicit foreground startup window for interactive login", async () => {
    process.env.CHROME_PATH = "/Applications/Google Chrome.app/test";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new Error("not running"))
        .mockResolvedValue({ ok: true }),
    );

    const { launchChrome } = await import("../../src/browser/launcher.js");

    await expect(launchChrome(9444, { background: false })).resolves.toBe(9444);
    const args = childProcessMocks.spawn.mock.calls[0]?.[1] as string[];
    expect(args).not.toContain("--no-startup-window");
  });
});
