/**
 * Chrome browser launcher and discovery.
 *
 * Finds an existing Chrome instance with CDP enabled, or launches one.
 * Supports macOS, Linux, and Windows.
 */

import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { CDPClient } from "./cdp-client.js";

const DEFAULT_CDP_PORT = 9222;

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
 * Check if Chrome CDP is already available on a port.
 */
export async function isCDPAvailable(
  port: number = DEFAULT_CDP_PORT,
): Promise<boolean> {
  try {
    const targets = await CDPClient.discoverTargets(port);
    return targets.length > 0;
  } catch {
    return false;
  }
}

/**
 * Launch Chrome with CDP enabled.
 * Returns the port number.
 */
export async function launchChrome(
  port: number = DEFAULT_CDP_PORT,
): Promise<number> {
  const chromePath = findChrome();
  if (!chromePath) {
    throw new Error(
      "Chrome not found. Install Google Chrome or set CHROME_PATH env var.",
    );
  }

  // Check if already running with CDP
  if (await isCDPAvailable(port)) {
    return port;
  }

  // Launch Chrome with remote debugging
  const args = [
    `--remote-debugging-port=${String(port)}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];

  // Use env override if set
  const actualPath = process.env.CHROME_PATH ?? chromePath;

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

/**
 * Get CDP port from environment or default.
 */
export function getCDPPort(): number {
  const envPort = process.env.UNICLI_CDP_PORT;
  if (envPort) return parseInt(envPort, 10);
  return DEFAULT_CDP_PORT;
}
