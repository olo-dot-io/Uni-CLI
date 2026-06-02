/**
 * @owner   src/browser/local-profiles.ts
 * @does    Discover local Chromium-family browser profiles without reading cookie values.
 * @needs   node:child_process, node:fs, node:os, node:path, Chromium profile Local State conventions
 * @feeds   src/browser/doctor.ts, src/commands/browser/index.ts, tests/unit/commands/browser.test.ts
 * @breaks  Missing or malformed profile metadata is skipped; filesystem errors do not expose secrets or raw cookies.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";

export interface LocalBrowserInstall {
  browser_name: string;
  browser_path: string;
  user_data_dir: string;
  browser_path_exists: boolean;
}

export interface LocalBrowserDebugPort {
  state: "not-recorded" | "recorded" | "invalid";
  port?: number;
  websocket_path?: string;
  source?: string;
}

export interface LocalBrowserProfile {
  id: string;
  browser_name: string;
  browser_path: string;
  browser_path_exists: boolean;
  user_data_dir: string;
  profile_dir: string;
  profile_name: string;
  profile_path: string;
  display_name: string;
  debug_port: LocalBrowserDebugPort;
}

export interface DefaultProfileDebugBlock {
  pid: number;
  browser_name: string;
  user_data_dir: string;
  reason: "chrome-default-user-data-dir-debug-blocked";
  next_step: string;
}

export interface LocalProfileDiscoveryOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

interface CandidateInstall {
  browserName: string;
  browserPath: string;
  userDataDir: string;
}

export function detectLocalBrowserProfiles(
  opts: LocalProfileDiscoveryOptions = {},
): LocalBrowserProfile[] {
  return detectProfilesFromInstalls(knownLocalBrowserInstalls(opts));
}

export function resolveLocalBrowserProfile(
  profileId: string,
  opts: LocalProfileDiscoveryOptions = {},
): LocalBrowserProfile | null {
  return (
    detectLocalBrowserProfiles(opts).find(
      (profile) => profile.id === profileId,
    ) ?? null
  );
}

export function resolvePreferredLocalBrowserProfile(
  opts: LocalProfileDiscoveryOptions & { profileId?: string } = {},
): LocalBrowserProfile | null {
  const requested = opts.profileId ?? opts.env?.UNICLI_BROWSER_PROFILE_ID;
  if (requested) return resolveLocalBrowserProfile(requested, opts);

  const profiles = detectLocalBrowserProfiles(opts);
  return (
    profiles.find((profile) => profile.id === "google-chrome:Default") ??
    profiles.find(
      (profile) =>
        profile.browser_name === "Google Chrome" &&
        profile.profile_dir === "Default",
    ) ??
    profiles.find((profile) => profile.profile_dir === "Default") ??
    profiles[0] ??
    null
  );
}

export function automationDefaultUserDataDir(
  opts: LocalProfileDiscoveryOptions = {},
): string {
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? env.HOME ?? homedir();
  return join(home, ".unicli", "chrome-profile");
}

export function automationUserDataDirForProfile(
  profile: LocalBrowserProfile,
  opts: LocalProfileDiscoveryOptions = {},
): string {
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? env.HOME ?? homedir();
  return join(
    home,
    ".unicli",
    "browser-profiles",
    profile.id.replace(/[^a-zA-Z0-9._-]+/g, "_"),
  );
}

export function readUserDataDirDebugPort(
  userDataDir: string,
): LocalBrowserDebugPort {
  return readDebugPort(userDataDir);
}

export function parseUserDataDirDebugPort(
  processList: string,
  userDataDir: string,
): LocalBrowserDebugPort {
  let fallback: LocalBrowserDebugPort | null = null;
  for (const line of processList.split(/\r?\n/)) {
    const match = line.match(/^\s*\d+\s+(.+)$/);
    if (!match) continue;
    const command = match[1];
    if (!command.includes("--remote-debugging-port=")) continue;
    if (extractUserDataDirArg(command) !== userDataDir) continue;
    const port = extractRemoteDebuggingPortArg(command);
    if (port === null) continue;
    const debugPort: LocalBrowserDebugPort = {
      state: "recorded",
      port,
      source: "process-list",
    };
    if (!command.includes("--type=")) return debugPort;
    fallback ??= debugPort;
  }
  return fallback ?? { state: "not-recorded" };
}

export function knownLocalBrowserInstalls(
  opts: LocalProfileDiscoveryOptions = {},
): LocalBrowserInstall[] {
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? env.HOME ?? homedir();
  const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";

  const candidates: CandidateInstall[] = [
    {
      browserName: "Google Chrome",
      browserPath:
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      userDataDir: join(
        home,
        "Library",
        "Application Support",
        "Google",
        "Chrome",
      ),
    },
    {
      browserName: "Chrome Canary",
      browserPath:
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      userDataDir: join(
        home,
        "Library",
        "Application Support",
        "Google",
        "Chrome Canary",
      ),
    },
    {
      browserName: "Brave",
      browserPath:
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      userDataDir: join(
        home,
        "Library",
        "Application Support",
        "BraveSoftware",
        "Brave-Browser",
      ),
    },
    {
      browserName: "Microsoft Edge",
      browserPath:
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      userDataDir: join(
        home,
        "Library",
        "Application Support",
        "Microsoft Edge",
      ),
    },
    {
      browserName: "Chromium",
      browserPath: "/Applications/Chromium.app/Contents/MacOS/Chromium",
      userDataDir: join(home, "Library", "Application Support", "Chromium"),
    },
    {
      browserName: "Arc",
      browserPath: "/Applications/Arc.app/Contents/MacOS/Arc",
      userDataDir: join(
        home,
        "Library",
        "Application Support",
        "Arc",
        "User Data",
      ),
    },
    {
      browserName: "Dia",
      browserPath: "/Applications/Dia.app/Contents/MacOS/Dia",
      userDataDir: join(home, "Library", "Application Support", "Dia"),
    },
    {
      browserName: "Comet",
      browserPath: "/Applications/Comet.app/Contents/MacOS/Comet",
      userDataDir: join(home, "Library", "Application Support", "Comet"),
    },
    {
      browserName: "Google Chrome",
      browserPath: "/usr/bin/google-chrome",
      userDataDir: join(home, ".config", "google-chrome"),
    },
    {
      browserName: "Google Chrome",
      browserPath: "/usr/bin/google-chrome-stable",
      userDataDir: join(home, ".config", "google-chrome"),
    },
    {
      browserName: "Chromium",
      browserPath: "/usr/bin/chromium",
      userDataDir: join(home, ".config", "chromium"),
    },
    {
      browserName: "Chromium",
      browserPath: "/usr/bin/chromium-browser",
      userDataDir: join(home, ".config", "chromium"),
    },
    {
      browserName: "Brave",
      browserPath: "/usr/bin/brave-browser",
      userDataDir: join(home, ".config", "BraveSoftware", "Brave-Browser"),
    },
    {
      browserName: "Microsoft Edge",
      browserPath: "/usr/bin/microsoft-edge",
      userDataDir: join(home, ".config", "microsoft-edge"),
    },
    {
      browserName: "Google Chrome",
      browserPath: join(
        programFiles,
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
      userDataDir: join(localAppData, "Google", "Chrome", "User Data"),
    },
    {
      browserName: "Google Chrome",
      browserPath: join(
        programFilesX86,
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
      userDataDir: join(localAppData, "Google", "Chrome", "User Data"),
    },
    {
      browserName: "Microsoft Edge",
      browserPath: join(
        programFiles,
        "Microsoft",
        "Edge",
        "Application",
        "msedge.exe",
      ),
      userDataDir: join(localAppData, "Microsoft", "Edge", "User Data"),
    },
    {
      browserName: "Brave",
      browserPath: join(
        programFiles,
        "BraveSoftware",
        "Brave-Browser",
        "Application",
        "brave.exe",
      ),
      userDataDir: join(
        localAppData,
        "BraveSoftware",
        "Brave-Browser",
        "User Data",
      ),
    },
  ];

  const installs: LocalBrowserInstall[] = [];
  const seen = new Map<string, number>();
  for (const candidate of candidates) {
    const browserPathExists = existsSync(candidate.browserPath);
    if (!browserPathExists && !existsSync(candidate.userDataDir)) continue;

    const key = `${candidate.browserName}\0${candidate.userDataDir}`;
    const install: LocalBrowserInstall = {
      browser_name: candidate.browserName,
      browser_path: candidate.browserPath,
      user_data_dir: candidate.userDataDir,
      browser_path_exists: browserPathExists,
    };
    const existingIndex = seen.get(key);
    if (existingIndex === undefined) {
      seen.set(key, installs.length);
      installs.push(install);
    } else if (
      !installs[existingIndex].browser_path_exists &&
      browserPathExists
    ) {
      installs[existingIndex] = install;
    }
  }
  return installs;
}

export function detectDefaultProfileDebugBlocks(
  opts: LocalProfileDiscoveryOptions & { processList?: string } = {},
): DefaultProfileDebugBlock[] {
  const processList = opts.processList ?? readProcessList();
  if (!processList) return [];
  return parseDefaultProfileDebugBlocks(
    processList,
    knownLocalBrowserInstalls(opts),
  );
}

export function parseDefaultProfileDebugBlocks(
  processList: string,
  installs: LocalBrowserInstall[],
): DefaultProfileDebugBlock[] {
  const blocks: DefaultProfileDebugBlock[] = [];
  const seen = new Set<string>();
  for (const line of processList.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2];
    if (!command.includes("--remote-debugging-port=")) continue;
    const userDataDir = extractUserDataDirArg(command);
    if (!userDataDir) continue;
    const install = installs.find((candidate) => {
      return (
        candidate.user_data_dir === userDataDir &&
        matchesBrowserExecutable(command, candidate.browser_path)
      );
    });
    if (!install) continue;
    const key = `${pid}\0${userDataDir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    blocks.push({
      pid,
      browser_name: install.browser_name,
      user_data_dir: userDataDir,
      reason: "chrome-default-user-data-dir-debug-blocked",
      next_step:
        "Use `unicli browser doctor --repair`; do not launch CDP against the browser default profile.",
    });
  }
  return blocks;
}

function readProcessList(): string {
  try {
    return execFileSync("ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    });
  } catch {
    return "";
  }
}

function extractUserDataDirArg(command: string): string | null {
  const match = command.match(
    /--user-data-dir=(?:"([^"]+)"|'([^']+)'|(.+?)(?=\s--|$))/,
  );
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? null)?.trim() ?? null;
}

function extractRemoteDebuggingPortArg(command: string): number | null {
  const match = command.match(/--remote-debugging-port=(\d+)/);
  const port = Number(match?.[1]);
  return Number.isInteger(port) && port > 0 ? port : null;
}

function matchesBrowserExecutable(
  command: string,
  browserPath: string,
): boolean {
  if (command.includes(browserPath)) return true;
  const executableName = command.match(/^\s*(\S+)/)?.[1];
  if (!executableName || executableName.includes("/")) return false;
  return executableName === basename(browserPath);
}

function detectProfilesFromInstalls(
  installs: LocalBrowserInstall[],
): LocalBrowserProfile[] {
  const profiles: LocalBrowserProfile[] = [];
  const seen = new Set<string>();
  for (const install of installs) {
    if (!existsSync(install.user_data_dir)) continue;
    const profileNames = loadProfileNamesFromLocalState(install.user_data_dir);
    const debugPort = readDebugPort(install.user_data_dir);
    let entries: string[];
    try {
      entries = readdirSync(install.user_data_dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }

    for (const profileDir of entries) {
      const profilePath = join(install.user_data_dir, profileDir);
      if (!isValidProfileDir(profilePath)) continue;
      const seenKey = `${install.user_data_dir}\0${profileDir}`;
      if (seen.has(seenKey)) continue;
      seen.add(seenKey);

      const profileName = profileNames.get(profileDir) ?? profileDir;
      profiles.push({
        id: `${browserSlug(install.browser_name)}:${profileDir}`,
        browser_name: install.browser_name,
        browser_path: install.browser_path,
        browser_path_exists: install.browser_path_exists,
        user_data_dir: install.user_data_dir,
        profile_dir: profileDir,
        profile_name: profileName,
        profile_path: profilePath,
        display_name: `${install.browser_name} - ${profileName}`,
        debug_port: debugPort,
      });
    }
  }

  return profiles.sort((a, b) => {
    const browser = a.browser_name.localeCompare(b.browser_name);
    if (browser !== 0) return browser;
    const dir = profileDirSortKey(a.profile_dir).localeCompare(
      profileDirSortKey(b.profile_dir),
    );
    if (dir !== 0) return dir;
    return naturalCompare(a.profile_name, b.profile_name);
  });
}

function loadProfileNamesFromLocalState(
  userDataDir: string,
): Map<string, string> {
  try {
    const parsed = JSON.parse(
      readFileSync(join(userDataDir, "Local State"), "utf-8"),
    ) as {
      profile?: { info_cache?: Record<string, { name?: unknown }> };
    };
    const infoCache = parsed.profile?.info_cache ?? {};
    return new Map(
      Object.entries(infoCache)
        .filter((entry): entry is [string, { name: string }] => {
          const name = entry[1].name;
          return typeof name === "string" && name.trim().length > 0;
        })
        .map(([profileDir, info]) => [profileDir, info.name]),
    );
  } catch {
    return new Map();
  }
}

function isValidProfileDir(profilePath: string): boolean {
  return ["Preferences", "Cookies", join("Network", "Cookies"), "History"].some(
    (relativePath) => existsSync(join(profilePath, relativePath)),
  );
}

function readDebugPort(userDataDir: string): LocalBrowserDebugPort {
  const source = join(userDataDir, "DevToolsActivePort");
  const fromFile = existsSync(source)
    ? readDebugPortFile(source)
    : ({ state: "not-recorded" } satisfies LocalBrowserDebugPort);
  if (fromFile.state === "recorded") return fromFile;

  const fromProcess = parseUserDataDirDebugPort(readProcessList(), userDataDir);
  return fromProcess.state === "recorded" ? fromProcess : fromFile;
}

function readDebugPortFile(source: string): LocalBrowserDebugPort {
  try {
    const [rawPort, websocketPath] = readFileSync(source, "utf-8")
      .split(/\r?\n/)
      .map((line) => line.trim());
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port <= 0 || !websocketPath) {
      return { state: "invalid", source };
    }
    return {
      state: "recorded",
      port,
      websocket_path: websocketPath,
      source,
    };
  } catch {
    return { state: "invalid", source };
  }
}

function browserSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function profileDirSortKey(profileDir: string): string {
  return profileDir === "Default" ? "" : profileDir;
}

function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}
