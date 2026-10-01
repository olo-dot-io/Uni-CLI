/**
 * External CLI Hub — registry and auto-discovery for third-party CLIs.
 *
 * Reads the external CLI registries at startup, checks which binaries are
 * installed on $PATH, and exposes lookup helpers for the rest of the
 * system (Commander registration, `unicli ext` subcommands, AGENTS.md).
 */

import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { delimiter, extname, join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Types ───────────────────────────────────────────────────────────────

export interface ExternalCli {
  name: string;
  binary: string;
  description: string;
  homepage?: string;
  tags?: string[];
  provenance?: "official" | "community";
  native_surface?: "cli" | "mcp-server" | "cli+mcp";
  provider_scope?: string;
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

export function isInstalled(binary: string): boolean {
  const cached = _installedCache.get(binary);
  if (cached !== undefined) return cached;

  const extensions =
    process.platform === "win32" && !extname(binary)
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];
  const directories =
    binary.includes(sep) ||
    (process.platform === "win32" && binary.includes("/"))
      ? [""]
      : [...new Set((process.env.PATH ?? "/usr/bin:/bin").split(delimiter))];
  const installed = directories.some((directory) =>
    extensions.some((extension) => {
      const executable = join(directory, `${binary}${extension}`);
      try {
        if (!statSync(executable, { throwIfNoEntry: false })?.isFile()) {
          return false;
        }
        accessSync(executable, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }),
  );
  _installedCache.set(binary, installed);
  return installed;
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
