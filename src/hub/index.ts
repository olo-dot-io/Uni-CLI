/**
 * External CLI Hub — registry and auto-discovery for third-party CLIs.
 *
 * Reads the external CLI registries at startup, checks which binaries are
 * installed on $PATH, and exposes lookup helpers for the rest of the
 * system (Commander registration, `unicli ext` subcommands, AGENTS.md).
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Types ───────────────────────────────────────────────────────────────

export interface ExternalCli {
  name: string;
  binary: string;
  description: string;
  homepage?: string;
  tags?: string[];
  json_flag?: string;
  install?: Record<string, string>;
}

// ── Cache ───────────────────────────────────────────────────────────────

let _cache: ExternalCli[] | null = null;
const _installedCache = new Map<string, boolean>();
const REGISTRY_FILES = ["external-clis.yaml", "external-clis-harness.yaml"];

// ── Loader ──────────────────────────────────────────────────────────────

/**
 * Resolve the YAML registry path.
 *
 * The YAML file ships alongside the TypeScript source in `src/hub/`.
 * At runtime we may be executing from `dist/hub/`, so we try the source
 * sibling first (`../../src/hub/`) then fall back to the co-located path.
 */
function resolveYamlPath(fileName: string): string | null {
  // Running from dist/hub/index.js → ../../src/hub/external-clis.yaml
  const fromDist = join(__dirname, "..", "..", "src", "hub", fileName);
  // Running from src/hub/index.ts (dev via tsx)
  const fromSrc = join(__dirname, fileName);

  // Prefer the source copy (always present in both dev & installed package)
  if (existsSync(fromSrc)) return fromSrc;
  if (existsSync(fromDist)) return fromDist;
  return null;
}

function readRegistryFile(fileName: string): ExternalCli[] {
  const path = resolveYamlPath(fileName);
  if (!path) return [];

  const raw = readFileSync(path, "utf-8");
  const parsed = yaml.load(raw);
  return Array.isArray(parsed) ? (parsed as ExternalCli[]) : [];
}

function dedupeRegistry(entries: ExternalCli[]): ExternalCli[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.name}\0${entry.binary}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Load and parse the external CLI registry from YAML.
 * Results are cached after the first call.
 */
export function loadExternalClis(): ExternalCli[] {
  if (_cache) return _cache;

  try {
    _cache = dedupeRegistry(REGISTRY_FILES.flatMap(readRegistryFile));
    return _cache;
  } catch {
    _cache = [];
    return _cache;
  }
}

// ── Discovery ───────────────────────────────────────────────────────────

/**
 * Check whether a binary is available on $PATH.
 * Uses `which` (macOS/Linux) with a short timeout.  Results are cached.
 */
export function isInstalled(binary: string): boolean {
  if (_installedCache.has(binary)) {
    return _installedCache.get(binary)!;
  }

  try {
    execFileSync("which", [binary], {
      stdio: "pipe",
      timeout: 3_000,
    });
    _installedCache.set(binary, true);
    return true;
  } catch {
    _installedCache.set(binary, false);
    return false;
  }
}

/**
 * Return every registered external CLI with its install status.
 */
export function listExternalClis(): Array<
  ExternalCli & { installed: boolean }
> {
  return loadExternalClis().map((cli) => ({
    ...cli,
    installed: isInstalled(cli.binary),
  }));
}

/**
 * Look up a single external CLI by name.
 */
export function getExternalCli(name: string): ExternalCli | undefined {
  return loadExternalClis().find((c) => c.name === name);
}
