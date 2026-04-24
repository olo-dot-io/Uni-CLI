import { describe, expect, it } from "vitest";

import { getElectronApps } from "../../src/electron-apps.js";
import { loadAllAdapters, loadTsAdapters } from "../../src/discovery/loader.js";
import { listCommands } from "../../src/registry.js";

describe("Electron desktop command discovery", () => {
  it("ships at least 30 reusable Electron desktop app profiles", () => {
    expect(Object.keys(getElectronApps()).length).toBeGreaterThanOrEqual(30);
  });

  it("registers generic desktop commands on Electron apps", async () => {
    loadAllAdapters();
    await loadTsAdapters();

    const ids = new Set(listCommands().map((c) => `${c.site}/${c.command}`));

    for (const site of ["slack", "notion", "vscode", "figma", "obsidian"]) {
      expect(ids).toContain(`${site}/open-app`);
      expect(ids).toContain(`${site}/status-app`);
      expect(ids).toContain(`${site}/dump`);
      expect(ids).toContain(`${site}/click-text`);
    }
  });

  it("registers media-specific controls for music Electron apps", async () => {
    loadAllAdapters();
    await loadTsAdapters();

    const ids = new Set(listCommands().map((c) => `${c.site}/${c.command}`));

    expect(ids).toContain("netease-music/play-liked");
    expect(ids).toContain("netease-music/next");
    expect(ids).toContain("netease-music/prev");
    expect(ids).toContain("netease-music/toggle");
    expect(ids).toContain("spotify/open-app");
    expect(ids).toContain("spotify/toggle");
  });
});
