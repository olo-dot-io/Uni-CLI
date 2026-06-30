import { describe, expect, it } from "vitest";
import {
  parseDebugPortProcessTargets,
  parseDefaultProfileDebugBlocks,
  parseUserDataDirDebugPort,
  type LocalBrowserInstall,
} from "../../src/browser/local-profiles.js";

describe("local browser profile diagnostics", () => {
  it("classifies Chrome default-profile remote-debugging launches as blocked", () => {
    const installs: LocalBrowserInstall[] = [
      {
        browser_name: "Google Chrome",
        browser_path:
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        browser_path_exists: true,
        user_data_dir:
          "/Users/example/Library/Application Support/Google/Chrome",
      },
    ];
    const processList = [
      '14018 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222 --user-data-dir="/Users/example/Library/Application Support/Google/Chrome" --profile-directory=Default',
      "24578 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222 --user-data-dir=/Users/example/.unicli/chrome-profile",
    ].join("\n");

    expect(parseDefaultProfileDebugBlocks(processList, installs)).toEqual([
      {
        pid: 14018,
        browser_name: "Google Chrome",
        user_data_dir:
          "/Users/example/Library/Application Support/Google/Chrome",
        reason: "chrome-default-user-data-dir-debug-blocked",
        next_step:
          "Use `unicli browser doctor --repair`; do not launch CDP against the browser default profile.",
      },
    ]);
  });

  it("detects Linux default-profile launches when ps reports only the executable name", () => {
    const installs: LocalBrowserInstall[] = [
      {
        browser_name: "Google Chrome",
        browser_path: "/usr/bin/google-chrome",
        browser_path_exists: true,
        user_data_dir: "/home/example/.config/google-chrome",
      },
    ];
    const processList = [
      "14018 google-chrome --remote-debugging-port=9222 --user-data-dir=/home/example/.config/google-chrome --profile-directory=Default",
      "14019 google-chrome-helper --remote-debugging-port=9222 --user-data-dir=/home/example/.config/google-chrome",
    ].join("\n");

    expect(parseDefaultProfileDebugBlocks(processList, installs)).toEqual([
      expect.objectContaining({
        pid: 14018,
        browser_name: "Google Chrome",
        user_data_dir: "/home/example/.config/google-chrome",
      }),
    ]);
  });

  it("recovers a CDP port for an automation profile from the process list", () => {
    const processList = [
      "14018 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9223 --user-data-dir=/Users/example/.unicli/browser-profiles/google-chrome_Default --no-startup-window",
      "14019 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper --type=renderer --remote-debugging-port=9223 --user-data-dir=/Users/example/.unicli/browser-profiles/google-chrome_Default",
    ].join("\n");

    expect(
      parseUserDataDirDebugPort(
        processList,
        "/Users/example/.unicli/browser-profiles/google-chrome_Default",
      ),
    ).toEqual({
      state: "recorded",
      port: 9223,
      source: "process-list",
    });
  });

  it("parses quoted automation profile paths with spaces", () => {
    const processList =
      '14018 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9231 --user-data-dir="/Users/example/.unicli/browser profiles/google chrome Default" --no-startup-window';

    expect(
      parseUserDataDirDebugPort(
        processList,
        "/Users/example/.unicli/browser profiles/google chrome Default",
      ),
    ).toMatchObject({ state: "recorded", port: 9231 });
  });

  it("lists process-verified debug targets by port and user-data-dir", () => {
    const processList = [
      "14018 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9333 --user-data-dir=/var/folders/t/unicli-chrome-ephemeral-abc --no-startup-window",
      "14019 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper --type=renderer --remote-debugging-port=9333 --user-data-dir=/var/folders/t/unicli-chrome-ephemeral-abc",
      "15018 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9444 --user-data-dir=/Users/example/.unicli/chrome-profile",
    ].join("\n");

    expect(parseDebugPortProcessTargets(processList)).toEqual([
      {
        port: 9333,
        user_data_dir: "/var/folders/t/unicli-chrome-ephemeral-abc",
        source: "process-list",
      },
      {
        port: 9444,
        user_data_dir: "/Users/example/.unicli/chrome-profile",
        source: "process-list",
      },
    ]);
  });
});
