import { describe, expect, it } from "vitest";
import {
  parseDefaultProfileDebugBlocks,
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
});
