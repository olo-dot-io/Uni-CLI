/**
 * Plugin system — install third-party adapters from GitHub or local paths.
 *
 * Storage:
 *   ~/.unicli/plugins/<name>/     — standalone plugins
 *   ~/.unicli/plugins.lock.json   — version lock file
 */

import {
  existsSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const PLUGINS_DIR = join(homedir(), ".unicli", "plugins");
const LOCK_FILE = join(homedir(), ".unicli", "plugins.lock.json");

export interface PluginInfo {
  name: string;
  path: string;
  commands: number;
  source?: string;
  version?: string;
  installedAt?: string;
}

interface LockEntry {
  source: string;
  commitHash?: string;
  installedAt: string;
  updatedAt?: string;
}

type LockFile = Record<string, LockEntry>;

function readLock(): LockFile {
  try {
    return JSON.parse(readFileSync(LOCK_FILE, "utf-8")) as LockFile;
  } catch {
    return {};
  }
}

function writeLock(lock: LockFile): void {
  mkdirSync(join(homedir(), ".unicli"), { recursive: true });
  writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2), "utf-8");
}

/**
 * Parse a plugin source string into a normalized form.
 * Supports: github:user/repo, https://github.com/user/repo, /local/path, file:///path
 */
function parseSource(source: string): {
  type: "git" | "local";
  url: string;
  name: string;
} {
  if (source.startsWith("github:")) {
    const repo = source.slice(7);
    const name = repo.split("/").pop()!;
    return { type: "git", url: `https://github.com/${repo}.git`, name };
  }
  if (source.startsWith("https://github.com/")) {
    const name = source
      .split("/")
      .pop()!
      .replace(/\.git$/, "");
    return {
      type: "git",
      url: source.endsWith(".git") ? source : source + ".git",
      name,
    };
  }
  if (source.startsWith("file://")) {
    const path = source.slice(7);
    const name = path.split("/").pop()!;
    return { type: "local", url: path, name };
  }
  // Assume local path
  const name = source.split("/").pop()!;
  return { type: "local", url: source, name };
}

/**
 * Install a plugin from a source.
 */
export function installPlugin(source: string): PluginInfo {
  const parsed = parseSource(source);
  const destDir = join(PLUGINS_DIR, parsed.name);

  if (existsSync(destDir)) {
    throw new Error(
      `Plugin "${parsed.name}" already installed at ${destDir}. Use "unicli plugin update ${parsed.name}" to update.`,
    );
  }

  mkdirSync(PLUGINS_DIR, { recursive: true });

  if (parsed.type === "git") {
    execSync(`git clone --depth 1 "${parsed.url}" "${destDir}"`, {
      stdio: "pipe",
      timeout: 60_000,
    });
    // Install dependencies if package.json exists
    if (existsSync(join(destDir, "package.json"))) {
      execSync("npm install --omit=dev", {
        cwd: destDir,
        stdio: "pipe",
        timeout: 120_000,
      });
    }
  } else {
    // Local: symlink
    symlinkSync(parsed.url, destDir, "dir");
  }

  // Count adapters
  const commands = countAdapters(destDir);

  // Update lock file
  const lock = readLock();
  lock[parsed.name] = {
    source,
    installedAt: new Date().toISOString(),
    commitHash: parsed.type === "git" ? getCommitHash(destDir) : undefined,
  };
  writeLock(lock);

  return {
    name: parsed.name,
    path: destDir,
    commands,
    source,
    installedAt: lock[parsed.name].installedAt,
  };
}

/**
 * Uninstall a plugin.
 */
export function uninstallPlugin(name: string): void {
  const destDir = join(PLUGINS_DIR, name);
  if (!existsSync(destDir)) {
    throw new Error(`Plugin "${name}" is not installed.`);
  }
  rmSync(destDir, { recursive: true, force: true });

  const lock = readLock();
  delete lock[name];
  writeLock(lock);
}

/**
 * List all installed plugins.
 */
export function listPlugins(): PluginInfo[] {
  if (!existsSync(PLUGINS_DIR)) return [];
  const lock = readLock();

  return readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .map((d) => {
      const pluginDir = join(PLUGINS_DIR, d.name);
      const lockEntry = lock[d.name];
      return {
        name: d.name,
        path: pluginDir,
        commands: countAdapters(pluginDir),
        source: lockEntry?.source,
        installedAt: lockEntry?.installedAt,
      };
    });
}

/**
 * Update a plugin (git pull or re-clone).
 */
export function updatePlugin(name: string): PluginInfo {
  const destDir = join(PLUGINS_DIR, name);
  if (!existsSync(destDir)) {
    throw new Error(`Plugin "${name}" is not installed.`);
  }

  // Check if it's a git repo
  if (existsSync(join(destDir, ".git"))) {
    execSync("git pull --rebase", {
      cwd: destDir,
      stdio: "pipe",
      timeout: 60_000,
    });
    if (existsSync(join(destDir, "package.json"))) {
      execSync("npm install --omit=dev", {
        cwd: destDir,
        stdio: "pipe",
        timeout: 120_000,
      });
    }
  }

  const lock = readLock();
  if (lock[name]) {
    lock[name].updatedAt = new Date().toISOString();
    lock[name].commitHash = getCommitHash(destDir);
    writeLock(lock);
  }

  return {
    name,
    path: destDir,
    commands: countAdapters(destDir),
    source: lock[name]?.source,
    installedAt: lock[name]?.installedAt,
  };
}

function countAdapters(dir: string): number {
  try {
    const files = readdirSync(dir, { recursive: true }) as string[];
    return files.filter(
      (f) => f.endsWith(".yaml") || f.endsWith(".yml") || f.endsWith(".ts"),
    ).length;
  } catch {
    return 0;
  }
}

function getCommitHash(dir: string): string | undefined {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: dir,
      encoding: "utf-8",
    }).trim();
  } catch {
    return undefined;
  }
}
