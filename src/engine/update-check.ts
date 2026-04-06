/**
 * Non-blocking update checker.
 * Queries npm registry (cached 24h) and displays a banner on process exit
 * if a newer version of unicli is available.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import { VERSION } from "../constants.js";

const CACHE_PATH = join(homedir(), ".unicli", "update-check.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const REGISTRY_URL = "https://registry.npmjs.org/unicli/latest";

interface UpdateCache {
  latest: string;
  checkedAt: number;
}

/**
 * Non-blocking update check. Fire-and-forget.
 * Registers a process.on('exit') handler to display result.
 */
export function checkForUpdates(): void {
  // Skip in CI
  if (process.env.CI) return;

  // Skip in non-TTY (piped output)
  if (!process.stderr.isTTY) return;

  // Check cache first
  let cached: UpdateCache | undefined;
  try {
    const raw = readFileSync(CACHE_PATH, "utf-8");
    cached = JSON.parse(raw) as UpdateCache;
    if (Date.now() - cached.checkedAt < CACHE_TTL_MS) {
      // Cache is fresh — display on exit if newer
      if (cached.latest !== VERSION && isNewer(cached.latest, VERSION)) {
        registerExitMessage(cached.latest);
      }
      return;
    }
  } catch {
    // No cache or invalid cache — check registry
  }

  // Fire-and-forget fetch
  fetch(REGISTRY_URL, { signal: AbortSignal.timeout(3000) })
    .then((resp) => resp.json())
    .then((data: unknown) => {
      const latest = (data as { version: string }).version;
      // Write cache
      try {
        mkdirSync(join(homedir(), ".unicli"), { recursive: true });
        writeFileSync(
          CACHE_PATH,
          JSON.stringify({ latest, checkedAt: Date.now() }),
          "utf-8",
        );
      } catch {
        /* best effort */
      }

      if (latest !== VERSION && isNewer(latest, VERSION)) {
        registerExitMessage(latest);
      }
    })
    .catch(() => {
      /* network failure — silently ignore */
    });
}

/** Compare semver strings. Returns true if latest > current. Exported for testing. */
export function isNewer(latest: string, current: string): boolean {
  const l = latest.split(".").map(Number);
  const c = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

let _registered = false;
function registerExitMessage(latest: string): void {
  if (_registered) return;
  _registered = true;
  process.on("exit", (code) => {
    if (code === 0) {
      process.stderr.write(
        `\n${chalk.yellow(`Update available: ${VERSION} → ${latest}`)} — run ${chalk.cyan("npm i -g @zenalexa/unicli")} to upgrade\n`,
      );
    }
  });
}
