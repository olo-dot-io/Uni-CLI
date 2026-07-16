import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { LocalBrowserProfile } from "../../src/browser/local-profiles.js";
import { prepareSeededAutomationProfile } from "../../src/browser/profile-seed.js";

const childProcessMocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(() => ""),
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

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  return {
    ...actual,
    execSync: childProcessMocks.execSync,
    execFileSync: ((...args: Parameters<typeof actual.execFileSync>) =>
      args[0] === "/bin/ps" ||
      args[0] === "/usr/bin/lockf" ||
      args[0] === "/usr/bin/flock" ||
      args[0] === "/bin/flock"
        ? Reflect.apply(actual.execFileSync, actual, args)
        : Reflect.apply(
            childProcessMocks.execFileSync,
            undefined,
            args,
          )) as typeof actual.execFileSync,
    spawn: childProcessMocks.spawn,
  };
});

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
  const originalHome = process.env.HOME;

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

  function mockLiveDebugProcess(userDataDir: string, port: number): void {
    childProcessMocks.execFileSync.mockReturnValue(
      `14018 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=${String(port)} --user-data-dir="${userDataDir}" --no-startup-window`,
    );
  }

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    childProcessMocks.execFileSync.mockReturnValue("");
    mockSpawnSuccess();
    if (originalChromePath === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = originalChromePath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
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

    await expect(launchChrome(9444, { ephemeral: true })).resolves.toBe(9444);
    const args = childProcessMocks.spawn.mock.calls[0]?.[1] as string[];
    expect(args.find((arg) => arg.startsWith("--user-data-dir="))).toContain(
      "unicli-chrome-ephemeral-",
    );
    expect(args).toContain("--disable-extensions");
    expect(args).toContain("--no-startup-window");
    expect(args).not.toContain("--headless=new");
  });

  it("does not reuse an existing CDP browser for explicit ephemeral launch", async () => {
    process.env.CHROME_PATH = "/Applications/Google Chrome.app/test";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const { launchChrome } = await import("../../src/browser/launcher.js");

    await expect(launchChrome(9444, { ephemeral: true })).rejects.toThrow(
      "CDP port 9444 is already in use",
    );
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
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

    await expect(launchChrome(9444, { ephemeral: true })).rejects.toThrow(
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

    await expect(
      launchChrome(9444, { background: false, ephemeral: true }),
    ).resolves.toBe(9444);
    const args = childProcessMocks.spawn.mock.calls[0]?.[1] as string[];
    expect(args).not.toContain("--no-startup-window");
  });

  it("rejects CDP launch against a real default user-data-dir", async () => {
    const home = mkdtempSync(join(tmpdir(), "unicli-launcher-home-"));
    process.env.HOME = home;
    process.env.CHROME_PATH = "/Applications/Google Chrome.app/test";
    const chromeRoot = join(
      home,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
    );
    mkdirSync(chromeRoot, { recursive: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const { launchChrome } = await import("../../src/browser/launcher.js");

    try {
      await expect(
        launchChrome(9444, { userDataDir: chromeRoot }),
      ).rejects.toThrow(
        `Chrome disables remote debugging for the default user-data-dir: ${chromeRoot}`,
      );
      expect(childProcessMocks.spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses to refresh a seeded automation profile while it is running", async () => {
    const home = mkdtempSync(join(tmpdir(), "unicli-launcher-home-"));
    process.env.HOME = home;
    const profile: LocalBrowserProfile = {
      id: "google-chrome:Default",
      browser_name: "Google Chrome",
      browser_path: "/Applications/Google Chrome.app/test",
      browser_path_exists: true,
      user_data_dir: join(home, "Chrome"),
      profile_dir: "Default",
      profile_name: "Personal",
      profile_path: join(home, "Chrome", "Default"),
      display_name: "Google Chrome - Personal",
      debug_port: { state: "not-recorded" },
    };
    const targetUserDataDir = join(
      home,
      ".unicli",
      "browser-profiles",
      "google-chrome_Default",
    );
    mkdirSync(targetUserDataDir, { recursive: true });
    mockLiveDebugProcess(targetUserDataDir, 9444);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const { launchChrome } = await import("../../src/browser/launcher.js");

    try {
      await expect(
        launchChrome(9333, { seedProfile: profile, refreshProfile: true }),
      ).rejects.toThrow(
        "Cannot refresh Uni-CLI automation profile while it is running on port 9444",
      );
      expect(childProcessMocks.spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reuses a running seeded automation profile when only the source profile changed", async () => {
    const home = mkdtempSync(join(tmpdir(), "unicli-launcher-home-"));
    process.env.HOME = home;
    const sourceUserDataDir = join(home, "Chrome");
    const sourceProfilePath = join(sourceUserDataDir, "Default");
    mkdirSync(join(sourceProfilePath, "Network"), { recursive: true });
    writeFileSync(join(sourceUserDataDir, "Local State"), "{}");
    writeFileSync(join(sourceProfilePath, "Preferences"), "{}");
    writeFileSync(join(sourceProfilePath, "Network", "Cookies"), "cookie-db");
    const profile: LocalBrowserProfile = {
      id: "google-chrome:Default",
      browser_name: "Google Chrome",
      browser_path: "/Applications/Google Chrome.app/test",
      browser_path_exists: true,
      user_data_dir: sourceUserDataDir,
      profile_dir: "Default",
      profile_name: "Personal",
      profile_path: sourceProfilePath,
      display_name: "Google Chrome - Personal",
      debug_port: { state: "not-recorded" },
    };
    const targetUserDataDir = join(
      home,
      ".unicli",
      "browser-profiles",
      "google-chrome_Default",
    );
    await prepareSeededAutomationProfile(profile, targetUserDataDir, {
      platform: "darwin",
    });
    writeFileSync(join(sourceProfilePath, "Network", "Cookies"), "new-db");
    mockLiveDebugProcess(targetUserDataDir, 9444);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const { launchChrome } = await import("../../src/browser/launcher.js");
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });

    try {
      await expect(launchChrome(9333, { seedProfile: profile })).resolves.toBe(
        9444,
      );
      expect(childProcessMocks.spawn).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
