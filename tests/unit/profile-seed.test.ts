import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireKernelFileLock } from "../../src/browser/kernel-file-lock.js";
import type { LocalBrowserProfile } from "../../src/browser/local-profiles.js";
import {
  BrowserProfileSeedError,
  AUTOMATION_PROFILE_SEED_MANIFEST,
  inspectAutomationProfileSeed,
  isRunningSeedIdentityUsable,
  prepareSeededAutomationProfile,
  readAutomationProfileSeedManifest,
} from "../../src/browser/profile-seed.js";

describe("automation profile seed", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "unicli-profile-seed-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function createProfile(): LocalBrowserProfile {
    const userDataDir = join(root, "Chrome");
    const profilePath = join(userDataDir, "Default");
    mkdirSync(join(profilePath, "Network"), { recursive: true });
    writeFileSync(join(userDataDir, "Local State"), '{"os_crypt":{}}');
    writeFileSync(join(profilePath, "Preferences"), '{"profile":{}}');
    writeFileSync(join(profilePath, "Network", "Cookies"), "cookie-db");
    writeFileSync(join(profilePath, "Network", "Cookies-wal"), "cookie-wal");
    return {
      id: "google-chrome:Default",
      browser_name: "Google Chrome",
      browser_path:
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      browser_path_exists: true,
      user_data_dir: userDataDir,
      profile_dir: "Default",
      profile_name: "Personal",
      profile_path: profilePath,
      display_name: "Google Chrome - Personal",
      debug_port: { state: "not-recorded" },
    };
  }

  it("seeds Local State and cookie stores into a Uni-CLI-owned target", async () => {
    const profile = createProfile();
    const target = join(root, ".unicli", "chrome-profile");

    const first = await prepareSeededAutomationProfile(profile, target, {
      platform: "darwin",
    });

    expect(first.status).toBe("seeded");
    expect(readFileSync(join(target, "Local State"), "utf-8")).toBe(
      '{"os_crypt":{}}',
    );
    expect(
      readFileSync(join(target, "Default", "Network", "Cookies"), "utf-8"),
    ).toBe("cookie-db");
    expect(
      readFileSync(join(target, "Default", "Network", "Cookies-wal"), "utf-8"),
    ).toBe("cookie-wal");
    expect(readAutomationProfileSeedManifest(target)).toMatchObject({
      source_profile: {
        id: "google-chrome:Default",
        profile_dir: "Default",
      },
      target: {
        user_data_dir: target,
        profile_dir: "Default",
      },
    });

    const second = await prepareSeededAutomationProfile(profile, target, {
      platform: "darwin",
    });
    expect(second.status).toBe("fresh");
    expect(
      inspectAutomationProfileSeed(profile, target, { platform: "darwin" }),
    ).toMatchObject({
      status: "fresh",
      target_user_data_dir: target,
      target_profile_dir: "Default",
      target_state: { status: "snapshot" },
    });
  });

  it("reports target runtime mutation without invalidating the source seed", async () => {
    const profile = createProfile();
    const target = join(root, ".unicli", "chrome-profile");
    await prepareSeededAutomationProfile(profile, target, {
      platform: "darwin",
    });

    const targetCookieDb = join(target, "Default", "Network", "Cookies");
    writeFileSync(targetCookieDb, "runtime-cookie-db");
    const future = new Date(Date.now() + 10_000);
    utimesSync(targetCookieDb, future, future);

    expect(
      inspectAutomationProfileSeed(profile, target, { platform: "darwin" }),
    ).toMatchObject({
      status: "fresh",
      target_state: {
        status: "runtime-mutated",
        changed_files: ["Default/Network/Cookies"],
      },
    });
  });

  it("force reseeds a runtime-mutated automation profile from the source snapshot", async () => {
    const profile = createProfile();
    const target = join(root, ".unicli", "chrome-profile");
    await prepareSeededAutomationProfile(profile, target, {
      platform: "darwin",
    });

    const targetCookieDb = join(target, "Default", "Network", "Cookies");
    writeFileSync(targetCookieDb, "runtime-cookie-db");
    const reseed = await prepareSeededAutomationProfile(profile, target, {
      platform: "darwin",
      force: true,
    });

    expect(reseed.status).toBe("seeded");
    expect(readFileSync(targetCookieDb, "utf-8")).toBe("cookie-db");
  });

  it("reseeds when a manifest exists but a target login-state file is missing", async () => {
    const profile = createProfile();
    const target = join(root, ".unicli", "chrome-profile");
    await prepareSeededAutomationProfile(profile, target, {
      platform: "darwin",
    });

    rmSync(join(target, "Default", "Network", "Cookies"));

    expect(
      inspectAutomationProfileSeed(profile, target, { platform: "darwin" }),
    ).toMatchObject({
      status: "stale",
      stale_cause: "target-missing",
      target_state: {
        status: "missing",
        missing_files: ["Default/Network/Cookies"],
      },
    });

    const reseed = await prepareSeededAutomationProfile(profile, target, {
      platform: "darwin",
    });
    expect(reseed.status).toBe("seeded");
    expect(
      readFileSync(join(target, "Default", "Network", "Cookies"), "utf-8"),
    ).toBe("cookie-db");
  });

  it("marks the seed stale when the source cookie DB changes and reseeds it", async () => {
    const profile = createProfile();
    const target = join(root, ".unicli", "chrome-profile");
    await prepareSeededAutomationProfile(profile, target, {
      platform: "darwin",
    });

    const cookieDb = join(profile.profile_path, "Network", "Cookies");
    writeFileSync(cookieDb, "new-cookie-db");
    const future = new Date(Date.now() + 10_000);
    utimesSync(cookieDb, future, future);

    const stale = inspectAutomationProfileSeed(profile, target, {
      platform: "darwin",
    });
    expect(stale).toMatchObject({
      status: "stale",
      stale_cause: "source-changed",
    });
    expect(isRunningSeedIdentityUsable(stale)).toBe(true);

    const reseed = await prepareSeededAutomationProfile(profile, target, {
      platform: "darwin",
    });
    expect(reseed.status).toBe("seeded");
    expect(
      readFileSync(join(target, "Default", "Network", "Cookies"), "utf-8"),
    ).toBe("new-cookie-db");
  });

  it("reports corrupted manifests as identity errors instead of missing seeds", () => {
    const profile = createProfile();
    const target = join(root, ".unicli", "chrome-profile");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, AUTOMATION_PROFILE_SEED_MANIFEST), "{nope");

    expect(
      inspectAutomationProfileSeed(profile, target, { platform: "darwin" }),
    ).toMatchObject({
      status: "error",
      reason: expect.stringContaining("Seed manifest is invalid"),
    });
  });

  it("refuses to delete an incompatible legacy lock directory", async () => {
    const profile = createProfile();
    const target = join(root, ".unicli", "chrome-profile");
    mkdirSync(join(root, ".unicli"), { recursive: true });
    mkdirSync(`${target}.seed.lock`, { mode: 0o700 });
    writeFileSync(
      join(`${target}.seed.lock`, "owner.json"),
      JSON.stringify({ pid: process.pid, token: "live-owner" }),
    );

    await expect(
      prepareSeededAutomationProfile(profile, target, { platform: "darwin" }),
    ).rejects.toBeInstanceOf(BrowserProfileSeedError);
    expect(existsSync(target)).toBe(false);
  });

  it("reuses the persistent kernel lock inode after an earlier owner exited", async () => {
    const profile = createProfile();
    const target = join(root, ".unicli", "chrome-profile");
    mkdirSync(join(root, ".unicli"), { recursive: true });
    writeFileSync(
      `${target}.seed.lock`,
      JSON.stringify({ pid: 999_999, created_at: "2000-01-01T00:00:00Z" }),
    );

    await expect(
      prepareSeededAutomationProfile(profile, target, { platform: "darwin" }),
    ).resolves.toMatchObject({ status: "seeded" });
    expect(statSync(`${target}.seed.lock`).isFile()).toBe(true);
  });

  it("maps a live kernel owner to deterministic seed contention", async () => {
    const profile = createProfile();
    const target = join(root, ".unicli", "chrome-profile");
    mkdirSync(join(root, ".unicli"), { recursive: true });
    const owner = await acquireKernelFileLock(`${target}.seed.lock`);

    try {
      await expect(
        prepareSeededAutomationProfile(profile, target, {
          platform: "darwin",
        }),
      ).rejects.toMatchObject({ code: "seed-lock-held" });
      expect(existsSync(target)).toBe(false);
    } finally {
      await owner.release();
    }
  });

  it("does not claim unsupported platforms", async () => {
    const profile = createProfile();
    const target = join(root, ".unicli", "chrome-profile");

    await expect(
      prepareSeededAutomationProfile(profile, target, { platform: "win32" }),
    ).rejects.toThrow(/supported on macOS only/);
    expect(
      inspectAutomationProfileSeed(profile, target, { platform: "win32" }),
    ).toMatchObject({
      status: "unsupported",
    });
  });

  it("fails instead of creating an empty target when cookies are missing", async () => {
    const profile = createProfile();
    rmSync(join(profile.profile_path, "Network", "Cookies"), { force: true });
    rmSync(join(profile.profile_path, "Network", "Cookies-wal"), {
      force: true,
    });
    const target = join(root, ".unicli", "chrome-profile");

    await expect(
      prepareSeededAutomationProfile(profile, target, { platform: "darwin" }),
    ).rejects.toThrow(/no Cookies or Network\/Cookies database/);
    expect(existsSync(target)).toBe(false);
  });
});
