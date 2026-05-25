/**
 * @owner   src/browser/launcher.ts
 * @does    Discover Chrome-family executables, probe local CDP ports, find free debug ports, and launch Chrome with optional profile binding.
 * @needs   node:child_process, node:fs, node:net, node:path, src/electron-apps
 * @feeds   src/browser/bridge.ts, src/commands/browser/index.ts, src/commands/status.ts, transport CDP browser adapter
 * @breaks  Missing Chrome, occupied ports, and CDP startup timeouts throw explicit errors; callers decide repair or fallback.
 */

import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { getElectronApp, type ElectronAppEntry } from "../electron-apps.js";
import {
  automationDefaultUserDataDir,
  knownLocalBrowserInstalls,
} from "./local-profiles.js";

const DEFAULT_CDP_PORT = 9222;

export interface ChromeLaunchOptions {
  profile?: boolean;
  headless?: boolean;
  background?: boolean;
  browserPath?: string;
  userDataDir?: string;
  profileDirectory?: string;
  reuseExisting?: boolean;
  allowDefaultUserDataDir?: boolean;
}

/**
 * Check if a remote browser is configured via UNICLI_CDP_ENDPOINT.
 * When true, local Chrome launch should be skipped entirely.
 */
export function isRemoteBrowser(): boolean {
  return !!process.env.UNICLI_CDP_ENDPOINT;
}

/** Known Chrome executable paths by platform */
const CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: [
    "google-chrome",
    "google-chrome-stable",
    "chromium-browser",
    "chromium",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

/**
 * Find Chrome executable on this system.
 */
export function findChrome(): string | null {
  const paths = CHROME_PATHS[process.platform] ?? [];
  for (const p of paths) {
    if (process.platform === "linux") {
      try {
        execSync(`which ${p}`, { stdio: "ignore" });
        return p;
      } catch {
        continue;
      }
    } else if (existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * Check if a CDP port is responding.
 */
export async function isCDPAvailable(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/json`, {
      signal: AbortSignal.timeout(1000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function findAvailableCDPPort(
  preferredPort: number = DEFAULT_CDP_PORT,
  maxAttempts = 20,
): Promise<number> {
  if (!Number.isInteger(preferredPort) || preferredPort < 1) {
    throw new Error(`Invalid CDP port: ${String(preferredPort)}`);
  }
  for (let offset = 0; offset < maxAttempts; offset++) {
    const candidate = preferredPort + offset;
    if (candidate > 65535) break;
    if (await isTcpPortFree(candidate)) return candidate;
  }
  throw new Error(
    `No free local CDP port found from ${String(preferredPort)} after ${String(maxAttempts)} attempts`,
  );
}

async function isTcpPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Launch Chrome with CDP enabled.
 * Returns the port number.
 */
export async function launchChrome(
  port: number = DEFAULT_CDP_PORT,
  options?: ChromeLaunchOptions,
): Promise<number> {
  const chromePath = findChrome();
  const actualPath =
    process.env.CHROME_PATH ?? options?.browserPath ?? chromePath;
  if (!actualPath) {
    throw new Error(
      "Chrome not found. Install Google Chrome or set CHROME_PATH env var.",
    );
  }

  // Check if already running with CDP
  if (await isCDPAvailable(port)) {
    if (options?.reuseExisting === false) {
      throw new Error(`CDP port ${String(port)} is already in use`);
    }
    return port;
  }

  // Launch Chrome with remote debugging
  const args = [
    `--remote-debugging-port=${String(port)}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];

  // Dedicated automation profile or selected logged-in Chromium profile.
  const profileDir = options?.userDataDir ?? automationDefaultUserDataDir();
  if (
    options?.allowDefaultUserDataDir !== true &&
    isKnownDefaultUserDataDir(profileDir)
  ) {
    throw new Error(
      `Chrome disables remote debugging for the default user-data-dir: ${profileDir}. Use a Uni-CLI automation profile and import cookies from the logged-in profile instead.`,
    );
  }
  if (profileDir) {
    args.push(`--user-data-dir=${profileDir}`);
  }
  if (options?.profileDirectory) {
    args.push(`--profile-directory=${options.profileDirectory}`);
  }

  // Chrome's new headless mode (for CI / server environments)
  if (options?.headless) {
    args.push("--headless=new");
  } else if (options?.background !== false) {
    args.push("--no-startup-window");
  }

  const child = spawn(actualPath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Wait for CDP to become available (poll every 200ms, max 10s)
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    if (await isCDPAvailable(port)) {
      return port;
    }
    await new Promise<void>((r) => setTimeout(r, 200));
  }

  throw new Error(
    `Chrome launched but CDP not available on port ${String(port)} after 10s`,
  );
}

function isKnownDefaultUserDataDir(userDataDir: string): boolean {
  return knownLocalBrowserInstalls().some(
    (install) => install.user_data_dir === userDataDir,
  );
}

/**
 * Get CDP port from environment or default.
 */
export function getCDPPort(): number {
  const envPort = process.env.UNICLI_CDP_PORT;
  if (envPort) return parseInt(envPort, 10);
  return DEFAULT_CDP_PORT;
}

/**
 * Resolve Electron app CDP endpoint.
 * Returns WebSocket URL for the most suitable target, or null.
 */
export async function resolveElectronEndpoint(
  site: string,
): Promise<{ wsUrl: string; port: number } | null> {
  // Check env override first
  const envEndpoint = process.env.UNICLI_CDP_ENDPOINT;
  if (envEndpoint) {
    return { wsUrl: envEndpoint, port: 0 };
  }

  const app = getElectronApp(site);
  if (!app) return null;

  if (!(await isCDPAvailable(app.port))) return null;

  // Discover targets and pick the best one
  try {
    const resp = await fetch(`http://127.0.0.1:${app.port}/json`, {
      signal: AbortSignal.timeout(2000),
    });
    const targets = (await resp.json()) as Array<{
      id: string;
      type: string;
      title: string;
      url: string;
      webSocketDebuggerUrl: string;
    }>;

    // Score targets: prefer page > app > webview, skip devtools/service_worker
    const scored = targets
      .filter(
        (t) => !t.url.startsWith("devtools://") && t.type !== "service_worker",
      )
      .map((t) => ({
        ...t,
        score:
          (t.type === "page" ? 80 : t.type === "app" ? 120 : 60) +
          (t.url.startsWith("http") ? 10 : 0),
      }))
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return null;
    return { wsUrl: scored[0].webSocketDebuggerUrl, port: app.port };
  } catch {
    return null;
  }
}

/**
 * Launch an Electron app with CDP debug port enabled.
 * Returns when the CDP endpoint is ready.
 */
export async function launchElectronApp(
  site: string,
): Promise<{ wsUrl: string; port: number }> {
  const app = getElectronApp(site);
  if (!app) throw new Error(`Unknown Electron app: ${site}`);

  // Already running with CDP?
  const existing = await resolveElectronEndpoint(site);
  if (existing) return existing;

  // Check if process is running without CDP
  try {
    const { execSync: syncExec } = await import("node:child_process");
    const result = syncExec(`pgrep -f "${app.processName}"`, {
      encoding: "utf-8",
    });
    if (result.trim()) {
      throw new Error(
        `${app.displayName ?? site} is running but CDP port ${app.port} is not available. ` +
          `Restart the app with: --remote-debugging-port=${app.port}`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("Restart")) throw err;
    // pgrep not found or no process — continue to launch
  }

  // Discover app path
  const appPath = await findElectronAppPath(app);
  if (!appPath) {
    throw new Error(
      `Could not find ${app.displayName ?? site}. Install it or set UNICLI_CDP_ENDPOINT.`,
    );
  }

  // Launch with CDP port
  const { spawn: spawnProc } = await import("node:child_process");
  const args = [
    `--remote-debugging-port=${app.port}`,
    ...(app.extraArgs ?? []),
  ];
  const proc = spawnProc(appPath, args, { detached: true, stdio: "ignore" });
  proc.unref();

  // Poll until CDP is available
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const endpoint = await resolveElectronEndpoint(site);
    if (endpoint) return endpoint;
  }

  throw new Error(
    `${app.displayName ?? site} failed to start CDP on port ${app.port} within 10s`,
  );
}

/**
 * Find the executable path for an Electron app.
 * macOS: mdfind by bundle ID, fallback to /Applications.
 */
async function findElectronAppPath(
  app: ElectronAppEntry,
): Promise<string | null> {
  if (process.platform === "darwin") {
    // Try mdfind first
    if (app.bundleId) {
      try {
        const { execSync: syncExec } = await import("node:child_process");
        const result = syncExec(
          `mdfind "kMDItemCFBundleIdentifier == '${app.bundleId}'" | head -1`,
          { encoding: "utf-8" },
        ).trim();
        if (result) {
          const execName = app.executableNames?.[0] ?? app.processName;
          return `${result}/Contents/MacOS/${execName}`;
        }
      } catch {
        /* mdfind failed */
      }
    }

    // Fallback: check /Applications
    const { existsSync: fsExists } = await import("node:fs");
    const appName = app.displayName ?? app.processName;
    const candidates = [
      `/Applications/${appName}.app/Contents/MacOS/${app.executableNames?.[0] ?? app.processName}`,
      `/Applications/${appName}.app/Contents/MacOS/Electron`,
      `${process.env.HOME}/Applications/${appName}.app/Contents/MacOS/${app.executableNames?.[0] ?? app.processName}`,
    ];
    for (const p of candidates) {
      if (fsExists(p)) return p;
    }
  }

  // Linux: check PATH
  if (process.platform === "linux") {
    try {
      const { execSync: syncExec } = await import("node:child_process");
      const result = syncExec(`which ${app.processName.toLowerCase()}`, {
        encoding: "utf-8",
      }).trim();
      if (result) return result;
    } catch {
      /* not in PATH */
    }
  }

  return null;
}
