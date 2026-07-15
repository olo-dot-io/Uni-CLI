/**
 * @owner   src/browser/chrome-policy.ts
 * @does    Detect Chrome remote-debugging policy state and publish Chrome 136+ CDP hardening guidance.
 * @needs   node:child_process, node:fs, node:path, Chrome Enterprise policy conventions
 * @feeds   src/browser/doctor.ts, tests/unit/chrome-policy.test.ts
 * @breaks  Policy probe failures become unknown diagnostics; the module never writes browser policy.
 * @invariants Guidance never claims Chrome policy can bypass the Chrome 136+ default-profile debugging restriction.
 * @side-effects Reads operating-system policy stores and may execute read-only policy inspection commands.
 * @perf     Policy detection performs bounded local filesystem/process probes only when doctor runs.
 * @concurrency Probes are read-only and independent across callers.
 * @test     tests/unit/chrome-policy.test.ts, tests/unit/browser-doctor.test.ts
 * @stability stable
 * @since    2026-06-26
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CHROME_REMOTE_DEBUGGING_OFFICIAL_SOURCES = [
  "https://developer.chrome.com/blog/remote-debugging-port",
  "https://support.google.com/chrome/a/answer/10314655",
  "https://chromeenterprise.google/policies/remote-debugging-allowed/",
] as const;

export interface ChromeRemoteDebuggingPolicyReport {
  name: "RemoteDebuggingAllowed";
  state: "allowed" | "disabled" | "not-configured" | "unknown";
  value?: boolean;
  source: string;
  source_path?: string;
  detail: string;
  next_step: string;
  commands: string[];
  official_docs: string[];
}

export interface Chrome136RemoteDebuggingGuidance {
  default_user_data_dir_cdp_supported: false;
  policy_can_bypass_default_user_data_dir: false;
  automatic_fix: "custom-user-data-dir";
  safe_command: "unicli browser --provider managed start";
  supported_paths: string[];
  unsupported_paths: string[];
  user_visible_warning: string;
  official_docs: string[];
}

export function buildChrome136RemoteDebuggingGuidance(): Chrome136RemoteDebuggingGuidance {
  return {
    default_user_data_dir_cdp_supported: false,
    policy_can_bypass_default_user_data_dir: false,
    automatic_fix: "custom-user-data-dir",
    safe_command: "unicli browser --provider managed start",
    supported_paths: [
      "Launch Chrome with a Uni-CLI-owned non-default --user-data-dir under ~/.unicli.",
      "Reuse login state by importing cookies from the selected local browser profile.",
      "Use Chrome for Testing or Chromium when a fully automation-owned browser is acceptable.",
      "Use the broker Chrome provider when its native host and extension are connected.",
      "Use UNICLI_CDP_ENDPOINT for a remote/cloud CDP browser.",
    ],
    unsupported_paths: [
      "Do not retry Google Chrome --remote-debugging-port against the browser default user-data-dir.",
      "Do not rely on RemoteDebuggingAllowed policy to bypass the Chrome 136+ default-directory restriction.",
      "Do not use unstable DevToolsDebuggingRestrictions feature flags as a supported repair path.",
    ],
    user_visible_warning:
      "Chrome 136+ ignores remote debugging switches for the default user-data-dir; Uni-CLI repairs this by starting a separate automation profile and reusing auth through cookie import.",
    official_docs: [...CHROME_REMOTE_DEBUGGING_OFFICIAL_SOURCES],
  };
}

export function detectChromeRemoteDebuggingPolicy(): ChromeRemoteDebuggingPolicyReport {
  try {
    const detected =
      detectMacPolicy() ?? detectLinuxPolicy() ?? detectWindowsPolicy();
    if (detected) return detected;
    return policyReportFromValue(null, {
      source: "not-found",
      detail:
        "No RemoteDebuggingAllowed policy was detected; Chrome treats remote debugging as allowed, subject to the Chrome 136+ non-default data-dir requirement.",
    });
  } catch (err) {
    return {
      name: "RemoteDebuggingAllowed",
      state: "unknown",
      source: "probe-error",
      detail: err instanceof Error ? err.message : String(err),
      next_step:
        "Open chrome://policy and confirm RemoteDebuggingAllowed is not false.",
      commands: ["open chrome://policy", "unicli browser doctor --json"],
      official_docs: [...CHROME_REMOTE_DEBUGGING_OFFICIAL_SOURCES],
    };
  }
}

export function policyReportFromValue(
  value: boolean | null,
  input: { source: string; source_path?: string; detail?: string },
): ChromeRemoteDebuggingPolicyReport {
  if (value === false) {
    return {
      name: "RemoteDebuggingAllowed",
      state: "disabled",
      value,
      source: input.source,
      ...(input.source_path ? { source_path: input.source_path } : {}),
      detail:
        input.detail ??
        "Chrome policy RemoteDebuggingAllowed=false blocks all remote-debugging switches, including Uni-CLI automation profiles.",
      next_step:
        "Remove the false Chrome policy or set RemoteDebuggingAllowed=true, then fully restart Chrome.",
      commands: policyRepairCommands(),
      official_docs: [...CHROME_REMOTE_DEBUGGING_OFFICIAL_SOURCES],
    };
  }
  if (value === true) {
    return {
      name: "RemoteDebuggingAllowed",
      state: "allowed",
      value,
      source: input.source,
      ...(input.source_path ? { source_path: input.source_path } : {}),
      detail:
        input.detail ??
        "Chrome policy explicitly allows remote debugging, but Chrome 136+ still requires a non-default user-data-dir.",
      next_step: "Use `unicli browser doctor --repair` for local CDP.",
      commands: ["unicli browser doctor --repair"],
      official_docs: [...CHROME_REMOTE_DEBUGGING_OFFICIAL_SOURCES],
    };
  }
  return {
    name: "RemoteDebuggingAllowed",
    state: "not-configured",
    source: input.source,
    ...(input.source_path ? { source_path: input.source_path } : {}),
    detail:
      input.detail ??
      "RemoteDebuggingAllowed is not configured, so Chrome allows remote debugging except for the Chrome 136+ default data-dir restriction.",
    next_step: "Use `unicli browser doctor --repair` for local CDP.",
    commands: ["unicli browser doctor --repair"],
    official_docs: [...CHROME_REMOTE_DEBUGGING_OFFICIAL_SOURCES],
  };
}

export function parsePolicyBoolean(raw: string): boolean | null {
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "enabled", "0x1", "0x00000001"].includes(normalized))
    return true;
  if (
    ["0", "false", "no", "disabled", "0x0", "0x00000000"].includes(normalized)
  )
    return false;
  return null;
}

function detectMacPolicy(): ChromeRemoteDebuggingPolicyReport | null {
  if (process.platform !== "darwin") return null;
  const candidates = [
    "/Library/Managed Preferences/com.google.Chrome",
    "/Library/Preferences/com.google.Chrome",
    "com.google.Chrome",
  ];
  for (const domain of candidates) {
    const value = readMacDefaultsBoolean(domain, "RemoteDebuggingAllowed");
    if (value === null) continue;
    return policyReportFromValue(value, {
      source: "mac-defaults",
      source_path: domain,
    });
  }
  return null;
}

function detectLinuxPolicy(): ChromeRemoteDebuggingPolicyReport | null {
  if (process.platform !== "linux") return null;
  const dirs = [
    "/etc/opt/chrome/policies/managed",
    "/etc/opt/chrome/policies/recommended",
    "/etc/chromium/policies/managed",
    "/etc/chromium/policies/recommended",
    "/etc/chrome/policies/managed",
    "/etc/chrome/policies/recommended",
  ];
  for (const dir of dirs) {
    const value = readLinuxPolicyBoolean(dir, "RemoteDebuggingAllowed");
    if (value === null) continue;
    return policyReportFromValue(value.value, {
      source: "linux-json-policy",
      source_path: value.sourcePath,
    });
  }
  return null;
}

function detectWindowsPolicy(): ChromeRemoteDebuggingPolicyReport | null {
  if (process.platform !== "win32") return null;
  const keys = [
    "HKLM\\Software\\Policies\\Google\\Chrome",
    "HKCU\\Software\\Policies\\Google\\Chrome",
  ];
  for (const key of keys) {
    const value = readWindowsRegistryBoolean(key, "RemoteDebuggingAllowed");
    if (value === null) continue;
    return policyReportFromValue(value, {
      source: "windows-registry",
      source_path: `${key}\\RemoteDebuggingAllowed`,
    });
  }
  return null;
}

function readMacDefaultsBoolean(domain: string, key: string): boolean | null {
  try {
    const raw = execFileSync("defaults", ["read", domain, key], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    });
    return parsePolicyBoolean(raw);
  } catch {
    return null;
  }
}

function readLinuxPolicyBoolean(
  dir: string,
  key: string,
): { value: boolean; sourcePath: string } | null {
  if (!existsSync(dir)) return null;
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .sort();
  } catch {
    return null;
  }
  for (const file of files) {
    const sourcePath = join(dir, file);
    try {
      const parsed = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<
        string,
        unknown
      >;
      const raw = parsed[key];
      if (typeof raw === "boolean") return { value: raw, sourcePath };
      if (typeof raw === "number") {
        const value = parsePolicyBoolean(String(raw));
        if (value !== null) return { value, sourcePath };
      }
      if (typeof raw === "string") {
        const value = parsePolicyBoolean(raw);
        if (value !== null) return { value, sourcePath };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function readWindowsRegistryBoolean(
  key: string,
  valueName: string,
): boolean | null {
  try {
    const raw = execFileSync("reg", ["query", key, "/v", valueName], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    });
    const line = raw.split(/\r?\n/).find((entry) => entry.includes(valueName));
    if (!line) return null;
    const value = line.trim().split(/\s+/).at(-1);
    return value ? parsePolicyBoolean(value) : null;
  } catch {
    return null;
  }
}

function policyRepairCommands(): string[] {
  switch (process.platform) {
    case "darwin":
      return [
        "open chrome://policy",
        "Remove any managed profile setting RemoteDebuggingAllowed=false, or install an admin-approved Chrome policy with RemoteDebuggingAllowed=true.",
        "Fully quit Chrome, then run `unicli browser doctor --repair`.",
      ];
    case "linux":
      return [
        "Open chrome://policy",
        "Remove RemoteDebuggingAllowed=false from /etc/opt/chrome/policies/* or /etc/chromium/policies/*, or set it to true.",
        "Restart Chrome, then run `unicli browser doctor --repair`.",
      ];
    case "win32":
      return [
        "Open chrome://policy",
        "Remove RemoteDebuggingAllowed=0 from HKLM/HKCU Software\\Policies\\Google\\Chrome, or set it to 1.",
        "Restart Chrome, then run `unicli browser doctor --repair`.",
      ];
    default:
      return [
        "Open chrome://policy",
        "Ensure RemoteDebuggingAllowed is not false, restart Chrome, then run `unicli browser doctor --repair`.",
      ];
  }
}
