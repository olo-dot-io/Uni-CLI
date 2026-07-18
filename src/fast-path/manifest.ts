/**
 * @owner       src::fast-path::manifest
 * @does        Loads and types the compact generated manifest used by discovery without booting Commander.
 * @needs       node fs/path/url, generated dist/manifest.json, and shared target-surface types
 * @feeds       fast-path list, search, describe, repair, and command-contract projection
 * @breaks      Omitting authentication or retrieval metadata makes fast-path discovery disagree with the live adapter registry.
 * @invariants  Loading is side-effect free; absence returns undefined for caller-controlled fallback; declared command metadata is preserved verbatim.
 * @side-effects Reads one generated JSON file when present.
 * @perf        One bounded synchronous manifest read and parse per process cache fill.
 * @concurrency Module state contains only the parsed immutable manifest cache.
 * @test        tests/unit/fast-path.test.ts
 * @stability   stable
 * @since       2026-04-01
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TargetSurface } from "../types.js";

export type ManifestArg = {
  name: string;
  type?: "str" | "int" | "float" | "bool";
  default?: unknown;
  required?: boolean;
  positional?: boolean;
  choices?: string[];
  description?: string;
  format?: string;
  "x-unicli-kind"?: string;
  "x-unicli-accepts"?: string[];
  "x-unicli-uri-origins"?: string[];
  "x-unicli-uri-path-pattern"?: string;
};

export type ManifestCommand = {
  name: string;
  description?: string;
  strategy?: string;
  type?: string;
  domain?: string;
  base?: string;
  browser?: boolean;
  quarantined?: boolean;
  args?: ManifestArg[];
  columns?: string[];
  defaultFormat?: string;
  capabilities?: string[];
  auth_requirement?: "required" | "optional" | "none";
  executables?: string[];
  minimum_capability?: string;
  pipeline_steps?: number;
  adapter_path?: string;
  target_surface?: TargetSurface;
};

export type Manifest = {
  version: string;
  sites: Record<
    string,
    {
      category?: string;
      commands: ManifestCommand[];
    }
  >;
};

export function manifestPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "manifest.json"),
    join(here, "..", "dist", "manifest.json"),
    join(here, "..", "..", "dist", "manifest.json"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error("Missing dist/manifest.json. Run: npm run build:manifest");
  }
  return found;
}

export function readManifest(): Manifest {
  return JSON.parse(readFileSync(manifestPath(), "utf8")) as Manifest;
}

export function isMissingManifestError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("Missing dist/manifest.json")
  );
}
