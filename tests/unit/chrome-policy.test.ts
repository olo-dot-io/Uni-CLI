import { describe, expect, it } from "vitest";
import {
  buildChrome136RemoteDebuggingGuidance,
  parsePolicyBoolean,
  policyReportFromValue,
} from "../../src/browser/chrome-policy.js";

describe("Chrome remote debugging policy diagnostics", () => {
  it("documents Chrome 136 default user-data-dir as unsupported", () => {
    const guidance = buildChrome136RemoteDebuggingGuidance();

    expect(guidance).toMatchObject({
      default_user_data_dir_cdp_supported: false,
      policy_can_bypass_default_user_data_dir: false,
      automatic_fix: "custom-user-data-dir",
      safe_command: "unicli browser --provider managed start",
    });
    expect(guidance.supported_paths).toEqual(
      expect.arrayContaining([
        "Launch Chrome with a Uni-CLI-owned non-default --user-data-dir under ~/.unicli.",
        "Use Chrome for Testing or Chromium when a fully automation-owned browser is acceptable.",
      ]),
    );
    expect(guidance.unsupported_paths).toEqual(
      expect.arrayContaining([
        "Do not rely on RemoteDebuggingAllowed policy to bypass the Chrome 136+ default-directory restriction.",
        "Do not use unstable DevToolsDebuggingRestrictions feature flags as a supported repair path.",
      ]),
    );
  });

  it("classifies RemoteDebuggingAllowed policy values", () => {
    expect(parsePolicyBoolean("0x00000001")).toBe(true);
    expect(parsePolicyBoolean("true")).toBe(true);
    expect(parsePolicyBoolean("0x00000000")).toBe(false);
    expect(parsePolicyBoolean("disabled")).toBe(false);
    expect(parsePolicyBoolean("maybe")).toBeNull();

    expect(
      policyReportFromValue(false, { source: "linux-json-policy" }),
    ).toMatchObject({
      name: "RemoteDebuggingAllowed",
      state: "disabled",
      value: false,
      next_step:
        "Remove the false Chrome policy or set RemoteDebuggingAllowed=true, then fully restart Chrome.",
    });
    expect(
      policyReportFromValue(true, { source: "mac-defaults" }),
    ).toMatchObject({
      state: "allowed",
      detail:
        "Chrome policy explicitly allows remote debugging, but Chrome 136+ still requires a non-default user-data-dir.",
    });
  });
});
