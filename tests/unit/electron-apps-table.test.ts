import { describe, expect, it } from "vitest";

import { findElectronApp, getElectronApps } from "../../src/electron-apps.js";

describe("Electron app CDP registry", () => {
  it("ships at least the planned 20 app profiles with unique debug ports", () => {
    const apps = getElectronApps();
    const entries = Object.entries(apps);

    expect(entries.length).toBeGreaterThanOrEqual(20);
    const ports = entries.map(([, app]) => app.port);
    expect(new Set(ports).size).toBe(ports.length);

    for (const [id, app] of entries) {
      expect(id).toMatch(/^[a-z0-9-]+$/);
      expect(app.port).toBeGreaterThanOrEqual(9222);
      expect(app.processName.length).toBeGreaterThan(0);
      expect(
        Boolean(app.bundleId) || Boolean(app.executableNames?.length),
      ).toBe(true);
      expect(app.displayName?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("resolves common app names, aliases, bundles, and executable names", () => {
    expect(findElectronApp("Slack")?.bundleId).toBe(
      "com.tinyspeck.slackmacgap",
    );
    expect(findElectronApp("com.tinyspeck.slackmacgap")?.processName).toBe(
      "Slack",
    );
    expect(findElectronApp("vs code")?.bundleId).toBe("com.microsoft.VSCode");
    expect(findElectronApp("Code")?.displayName).toBe("Visual Studio Code");
    expect(findElectronApp("netease music app")?.port).toBe(9238);
  });

  it("marks relaunch-risk apps explicitly for attach confirmation", () => {
    expect(findElectronApp("notion")?.relaunchLosesSession).toBe(true);
    expect(findElectronApp("netease music app")?.relaunchLosesSession).not.toBe(
      true,
    );
  });
});
