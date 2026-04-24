/**
 * Electron app registry — known Electron apps with CDP debug ports.
 *
 * Each app gets a unique CDP port for parallel debugging.
 * Users can extend via ~/.unicli/apps.yaml (additive only).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";

export interface ElectronAppEntry {
  port: number;
  processName: string;
  executableNames?: string[];
  bundleId?: string;
  displayName?: string;
  extraArgs?: string[];
}

const BUILTIN_APPS: Record<string, ElectronAppEntry> = {
  cursor: {
    port: 9226,
    processName: "Cursor",
    bundleId: "com.todesktop.runtime.Cursor",
    displayName: "Cursor",
  },
  codex: {
    port: 9222,
    processName: "Codex",
    bundleId: "com.openai.codex",
    displayName: "Codex CLI",
  },
  chatgpt: {
    port: 9236,
    processName: "ChatGPT",
    bundleId: "com.openai.chat",
    displayName: "ChatGPT",
  },
  notion: {
    port: 9230,
    processName: "Notion",
    bundleId: "notion.id",
    displayName: "Notion",
  },
  "discord-app": {
    port: 9232,
    processName: "Discord",
    bundleId: "com.hnc.Discord",
    displayName: "Discord",
  },
  chatwise: {
    port: 9228,
    processName: "ChatWise",
    bundleId: "com.chatwise.app",
    displayName: "ChatWise",
  },
  "doubao-app": {
    port: 9225,
    processName: "Doubao",
    bundleId: "com.volcengine.doubao",
    displayName: "Doubao",
  },
  antigravity: {
    port: 9234,
    processName: "Antigravity",
    executableNames: ["Electron", "Antigravity"],
    bundleId: "dev.antigravity.app",
    displayName: "Antigravity",
  },
  "netease-music": {
    port: 9238,
    processName: "NeteaseMusic",
    executableNames: ["NeteaseMusic", "网易云音乐"],
    bundleId: "com.netease.163music",
    displayName: "NeteaseMusic",
  },
};

let _apps: Record<string, ElectronAppEntry> | null = null;

/**
 * Get all known Electron apps (builtins + user extensions).
 * User apps from ~/.unicli/apps.yaml are additive only — cannot override builtins.
 */
export function getElectronApps(): Record<string, ElectronAppEntry> {
  if (_apps) return _apps;

  _apps = { ...BUILTIN_APPS };

  // Load user extensions
  try {
    const userAppsPath = join(homedir(), ".unicli", "apps.yaml");
    const content = readFileSync(userAppsPath, "utf-8");
    const parsed = yaml.load(content) as {
      apps?: Record<string, ElectronAppEntry>;
    };
    if (parsed?.apps) {
      for (const [name, entry] of Object.entries(parsed.apps)) {
        if (!(name in BUILTIN_APPS)) {
          _apps[name] = entry;
        }
      }
    }
  } catch {
    // No user apps file — that's fine
  }

  return _apps;
}

/**
 * Look up an Electron app by site name.
 */
export function getElectronApp(site: string): ElectronAppEntry | null {
  return getElectronApps()[site] ?? null;
}

/**
 * Look up an Electron app by any common identifier:
 * site key, process name, display name, executable name, or bundle ID.
 */
export function findElectronApp(target: string): ElectronAppEntry | null {
  const needle = target.trim().toLowerCase();
  if (!needle) return null;

  const direct = getElectronApp(needle);
  if (direct) return direct;

  for (const [site, entry] of Object.entries(getElectronApps())) {
    if (site.toLowerCase() === needle) return entry;
    if (entry.processName.toLowerCase() === needle) return entry;
    if (entry.displayName?.toLowerCase() === needle) return entry;
    if (entry.bundleId?.toLowerCase() === needle) return entry;
    if (entry.executableNames?.some((name) => name.toLowerCase() === needle)) {
      return entry;
    }
  }

  return null;
}

/**
 * Check if a site is a known Electron app.
 */
export function isElectronApp(site: string): boolean {
  return site in getElectronApps();
}
