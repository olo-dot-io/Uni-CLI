import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

/**
 * Adapter health gate.
 *
 * Runs as part of `npm run test:adapter`. Scans every YAML adapter for the
 * shape contract surrounding the quarantine flag so that a broken adapter
 * cannot silently bypass CI by sneaking in a malformed `quarantine` value.
 *
 * Network probes live in `scripts/adapter-health-probe.ts` and run inside the
 * CI `adapter-health` step — they are intentionally separated from this gate
 * so unit-level vitest runs stay offline and deterministic.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTERS_DIR = join(__dirname, "..", "..", "src", "adapters");

interface ParsedAdapter {
  site?: string;
  name?: string;
  quarantine?: unknown;
  quarantineReason?: unknown;
  pipeline?: unknown[];
  execArgs?: unknown[];
}

const entries: { rel: string; parsed: ParsedAdapter }[] = [];

for (const site of readdirSync(ADAPTERS_DIR)) {
  if (site.startsWith("_") || site.startsWith(".")) continue;
  const siteDir = join(ADAPTERS_DIR, site);
  if (!statSync(siteDir).isDirectory()) continue;

  for (const file of readdirSync(siteDir)) {
    if (extname(file) !== ".yaml" && extname(file) !== ".yml") continue;
    const rel = `${site}/${file}`;
    const raw = readFileSync(join(siteDir, file), "utf-8");
    const parsed = yaml.load(raw) as ParsedAdapter;
    entries.push({ rel, parsed });
  }
}

describe("adapter health gate", () => {
  it("scans at least one adapter", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it("every quarantine value is boolean when present", () => {
    const violations = entries.filter(
      ({ parsed }) =>
        parsed.quarantine !== undefined &&
        typeof parsed.quarantine !== "boolean",
    );
    expect(violations.map((v) => v.rel)).toEqual([]);
  });

  it("every quarantineReason is a string when quarantine=true", () => {
    const violations = entries.filter(
      ({ parsed }) =>
        parsed.quarantine === true &&
        parsed.quarantineReason !== undefined &&
        typeof parsed.quarantineReason !== "string",
    );
    expect(violations.map((v) => v.rel)).toEqual([]);
  });

  it("only quarantined adapters are allowed to omit pipeline/execArgs", () => {
    const violations = entries.filter(
      ({ parsed }) =>
        parsed.quarantine !== true && !parsed.pipeline && !parsed.execArgs,
    );
    expect(violations.map((v) => v.rel)).toEqual([]);
  });
});
