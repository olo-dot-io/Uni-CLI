import { beforeEach, describe, expect, it, vi } from "vitest";

const pageMock = vi.hoisted(() => ({
  page: {
    sendCDP: vi.fn().mockResolvedValue(undefined),
  },
}));

const browserPageMock = vi.hoisted(() => ({
  connect: vi.fn(),
}));

const launcherMock = vi.hoisted(() => ({
  launchChrome: vi.fn().mockResolvedValue(9333),
}));

const localProfileMock = vi.hoisted(() => ({
  resolvePreferredLocalBrowserProfile: vi.fn(() => ({
    id: "google-chrome:Default",
    browser_name: "Google Chrome",
    browser_path:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    browser_path_exists: true,
    user_data_dir: "/Users/example/Library/Application Support/Google/Chrome",
    profile_dir: "Default",
    profile_name: "Personal",
    profile_path:
      "/Users/example/Library/Application Support/Google/Chrome/Default",
    display_name: "Google Chrome - Personal",
    debug_port: { state: "not-recorded" },
  })),
  automationUserDataDirForProfile: vi.fn(
    () => "/Users/example/.unicli/browser-profiles/google-chrome_Default",
  ),
}));

const chromiumCookieMock = vi.hoisted(() => ({
  readCookies: vi.fn(() => [
    {
      host: ".x.com",
      name: "auth_token",
      value: "secret",
      path: "/",
      expires: 13_433_616_000_000_000,
      secure: true,
      httpOnly: true,
    },
  ]),
}));

vi.mock("../../src/browser/discover.js", () => ({
  checkDaemonStatus: vi.fn().mockResolvedValue({
    running: false,
    extensionConnected: false,
  }),
}));

vi.mock("../../src/browser/page.js", () => ({
  BrowserPage: {
    connect: browserPageMock.connect,
  },
}));

vi.mock("../../src/browser/launcher.js", () => launcherMock);

vi.mock("../../src/browser/stealth.js", () => ({
  injectStealth: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/browser/local-profiles.js", () => localProfileMock);

vi.mock("../../src/engine/chromium-cookies.js", () => chromiumCookieMock);

import { acquirePage } from "../../src/engine/steps/browser-helpers.js";

describe("browser user-session auth bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    browserPageMock.connect
      .mockRejectedValueOnce(new Error("CDP unavailable"))
      .mockRejectedValueOnce(new Error("CDP unavailable"))
      .mockResolvedValue(pageMock.page);
    pageMock.page.sendCDP.mockResolvedValue(undefined);
  });

  it("auto-starts CDP in an automation profile and imports cookies from the selected local profile", async () => {
    await expect(
      acquirePage({
        data: null,
        args: {},
        vars: {},
        browserSession: "user",
        site: "twitter",
        domain: "x.com",
      }),
    ).resolves.toBe(pageMock.page);

    expect(launcherMock.launchChrome).toHaveBeenCalledWith(
      9222,
      expect.objectContaining({
        browserPath:
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        userDataDir:
          "/Users/example/.unicli/browser-profiles/google-chrome_Default",
      }),
    );
    expect(chromiumCookieMock.readCookies).toHaveBeenCalledWith({
      browser: "chrome",
      domain: "x.com",
      profile: "Default",
    });
    expect(pageMock.page.sendCDP).toHaveBeenCalledWith("Network.setCookies", {
      cookies: [
        expect.objectContaining({
          domain: ".x.com",
          httpOnly: true,
          name: "auth_token",
          path: "/",
          secure: true,
          value: "secret",
        }),
      ],
    });
  });
});
