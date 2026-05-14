/**
 * Generated manifest reader — the discovery-only fast path consumes
 * `dist/manifest.json` instead of loading every adapter through Commander.
 *
 * Keep this module side-effect free: the entry decides whether absence of
 * the manifest is fatal or simply means "no fast path; fall through to the
 * full Commander tree".
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
