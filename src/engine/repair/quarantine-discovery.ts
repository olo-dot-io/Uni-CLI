/**
 * @owner   src/engine/repair/quarantine-discovery.ts
 * @does    Scan src/adapters for `quarantine: true` YAMLs and return a typed list with site, name, reason, and adapter path so agents can drive a sweep.
 * @needs   node:fs, node:path, js-yaml
 * @feeds   src/commands/repair.ts (--quarantined flag), future scheduled cron entries
 * @breaks  Caller resolves the adapters root; throws when the directory is missing rather than silently returning an empty list.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

export interface QuarantinedAdapter {
  site: string;
  name: string;
  reason: string;
  adapter_path: string;
  quarantined_since?: string;
}

export interface QuarantineParseError {
  adapter_path: string;
  message: string;
}

export interface QuarantineDiscoveryResult {
  adapters: QuarantinedAdapter[];
  parse_errors: QuarantineParseError[];
}

interface RawAdapter {
  site?: unknown;
  name?: unknown;
  quarantine?: unknown;
  quarantineReason?: unknown;
}

function* walkYaml(path: string): Generator<string> {
  const st = statSync(path);
  if (st.isFile()) {
    if (extname(path) === ".yaml" || extname(path) === ".yml") yield path;
    return;
  }
  for (const entry of readdirSync(path)) {
    if (entry.startsWith(".") || entry.startsWith("_")) continue;
    yield* walkYaml(join(path, entry));
  }
}

export function resolveAdaptersRoot(): string {
  const cwdTarget = resolve("src/adapters");
  if (existsSync(cwdTarget)) return cwdTarget;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, "..", "..", "adapters");
  if (existsSync(candidate)) return candidate;
  throw new Error(
    `adapters directory not found (tried ${cwdTarget}, ${candidate})`,
  );
}

const SINCE_RE = /\((\d{4}-\d{2}-\d{2})\)\s*$/;

export function discoverQuarantinedAdapters(
  root: string = resolveAdaptersRoot(),
): QuarantineDiscoveryResult {
  const adapters: QuarantinedAdapter[] = [];
  const parse_errors: QuarantineParseError[] = [];
  for (const file of walkYaml(root)) {
    let parsed: RawAdapter;
    try {
      parsed = yaml.load(readFileSync(file, "utf-8")) as RawAdapter;
    } catch (err) {
      // A YAML adapter that won't parse is exactly the population this
      // command is meant to surface. Hiding the failure (rule 02 silent
      // catch) defeats the feature's purpose. Bubble it as a typed entry.
      parse_errors.push({
        adapter_path: file,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    if (parsed.quarantine !== true) continue;
    const site = typeof parsed.site === "string" ? parsed.site : "";
    const name = typeof parsed.name === "string" ? parsed.name : "";
    const reason =
      typeof parsed.quarantineReason === "string"
        ? parsed.quarantineReason
        : "";
    if (!site || !name) continue;
    const sinceMatch = reason.match(SINCE_RE);
    adapters.push({
      site,
      name,
      reason,
      adapter_path: file,
      quarantined_since: sinceMatch ? sinceMatch[1] : undefined,
    });
  }
  adapters.sort(
    (a, b) => a.site.localeCompare(b.site) || a.name.localeCompare(b.name),
  );
  parse_errors.sort((a, b) => a.adapter_path.localeCompare(b.adapter_path));
  return { adapters, parse_errors };
}
