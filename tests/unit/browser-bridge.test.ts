import { beforeEach, describe, expect, it, vi } from "vitest";

const daemonMock = vi.hoisted(() => ({
  fetchDaemonStatus: vi.fn(),
  sendCommand: vi.fn(),
}));

const launcherMock = vi.hoisted(() => ({
  getCDPPort: vi.fn(() => 9222),
  isCDPAvailable: vi.fn(),
  isRemoteBrowser: vi.fn(() => false),
  launchChrome: vi.fn(),
}));

const pageMock = vi.hoisted(() => ({
  connect: vi.fn(),
}));

vi.mock("../../src/browser/daemon-client.js", () => ({
  fetchDaemonStatus: daemonMock.fetchDaemonStatus,
  sendCommand: daemonMock.sendCommand,
}));

vi.mock("../../src/browser/launcher.js", () => ({
  getCDPPort: launcherMock.getCDPPort,
  isCDPAvailable: launcherMock.isCDPAvailable,
  isRemoteBrowser: launcherMock.isRemoteBrowser,
  launchChrome: launcherMock.launchChrome,
}));

vi.mock("../../src/browser/page.js", () => ({
  BrowserPage: class BrowserPage {
    static connect = pageMock.connect;
  },
}));

import { BrowserBridge, DaemonPage } from "../../src/browser/bridge.js";

beforeEach(() => {
  vi.clearAllMocks();
  launcherMock.getCDPPort.mockReturnValue(9222);
  launcherMock.isRemoteBrowser.mockReturnValue(false);
});

function daemonStatus(extensionConnected: boolean) {
  return {
    ok: true,
    pid: 123,
    uptime: 10,
    extensionConnected,
    pending: 0,
    lastCliRequestTime: Date.now(),
    memoryMB: 32,
    port: 19825,
  };
}

describe("DaemonPage", () => {
  it("returns already-unwrapped exec results from evaluate", async () => {
    daemonMock.sendCommand.mockResolvedValueOnce("content");
    const page = new DaemonPage("test-workspace");

    await expect(page.evaluate("document.body.innerText")).resolves.toBe(
      "content",
    );
  });
});

describe("BrowserBridge auto-start behavior", () => {
  it("uses the daemon path immediately when the extension is connected", async () => {
    daemonMock.fetchDaemonStatus.mockResolvedValueOnce(daemonStatus(true));

    const page = await new BrowserBridge().connect({ workspace: "profile-a" });

    expect(page).toBeInstanceOf(DaemonPage);
    expect(pageMock.connect).not.toHaveBeenCalled();
  });

  it("falls back to auto-started local CDP when daemon has no extension", async () => {
    const directPage = { close: vi.fn() };
    daemonMock.fetchDaemonStatus.mockResolvedValue(daemonStatus(false));
    launcherMock.isCDPAvailable.mockResolvedValueOnce(false);
    launcherMock.launchChrome.mockResolvedValueOnce(9222);
    pageMock.connect.mockResolvedValueOnce(directPage);

    const page = await new BrowserBridge().connect({ timeout: 1 });

    expect(launcherMock.launchChrome).toHaveBeenCalledWith(9222);
    expect(pageMock.connect).toHaveBeenCalledWith(9222);
    expect(page).toBe(directPage);
  });
});
