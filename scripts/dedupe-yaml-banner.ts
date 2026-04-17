#!/usr/bin/env tsx
/**
 * One-off cleanup: dedupe the schema-v2 migration banner comment in
 * `src/adapters/<site>/<cmd>.yaml`.
 *
 * During v0.212 Shatalov the schema-v2 migration injected five fields
 * (`capabilities`, `minimum_capability`, `trust`, `confidentiality`,
 * `quarantine`) preceded by the marker comment
 *
 *   # schema-v2 metadata — injected by `unicli migrate schema-v2`
 *
 * In v0.213 Gagarin a second pass injected the `schema_version: v2` field
 * with its own copy of the same banner comment. Result: 887 of 896 YAML
 * adapters ship with two identical banner comments — purely cosmetic drag.
 *
 * This script coalesces the two banner blocks into one by removing the
 * SECOND occurrence of the banner comment line when it appears immediately
 * before `schema_version: v2`. The `schema_version: v2` data line itself
 * stays put. The script is idempotent: single-banner files are left alone.
 *
 * Usage:
 *   tsx scripts/dedupe-yaml-banner.ts --dry-run   # report, don't write
 *   tsx scripts/dedupe-yaml-banner.ts             # rewrite files in place
 *
 * Exit codes:
 *   0 — completed (check stderr for the affected-file count)
 *   1 — I/O failure on one or more files
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { readdirSync, statSync } from "node:fs";

const BANNER = "# schema-v2 metadata — injected by `unicli migrate schema-v2`";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const ADAPTERS_DIR = join(REPO_ROOT, "src", "adapters");

function walkYaml(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      out.push(...walkYaml(full));
    } else if (s.isFile() && full.endsWith(".yaml")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Dedupe the banner in one YAML source. Returns the rewritten source if a
 * change was needed; returns `null` if the file already has at most one
 * banner (or the duplicate pattern does not match the known shape).
 */
export function dedupeBanner(src: string): string | null {
  const lines = src.split("\n");
  const bannerIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === BANNER) bannerIdx.push(i);
  }
  if (bannerIdx.length < 2) return null;

  // Known duplicate pattern: second banner immediately precedes
  // `schema_version: v2`. Remove that second banner line and the blank line
  // directly above it (if present) to keep spacing tidy.
  const second = bannerIdx[bannerIdx.length - 1];
  if (lines[second + 1] !== "schema_version: v2") return null;

  // Drop the banner line itself; also drop one preceding blank if present,
  // since the migration emitted "\n# banner\nschema_version: v2".
  const dropStart =
    second - 1 >= 0 && lines[second - 1] === "" ? second - 1 : second;
  lines.splice(dropStart, second - dropStart + 1);
  return lines.join("\n");
}

function main(): void {
  const dryRun = process.argv.includes("--dry-run");
  const files = walkYaml(ADAPTERS_DIR);
  let changed = 0;
  let ioFailures = 0;

  for (const file of files) {
    let src: string;
    try {
      src = readFileSync(file, "utf-8");
    } catch (err) {
      ioFailures++;
      process.stderr.write(
        `[dedupe] read failed: ${relative(REPO_ROOT, file)} — ${err instanceof Error ? err.message : String(err)}\n`,
      );
      continue;
    }

    const deduped = dedupeBanner(src);
    if (deduped === null) continue;

    changed++;
    if (dryRun) {
      process.stderr.write(
        `[dedupe] would update: ${relative(REPO_ROOT, file)}\n`,
      );
    } else {
      try {
        writeFileSync(file, deduped, "utf-8");
      } catch (err) {
        ioFailures++;
        process.stderr.write(
          `[dedupe] write failed: ${relative(REPO_ROOT, file)} — ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  process.stderr.write(
    `[dedupe] ${dryRun ? "dry-run" : "applied"}: ${changed} of ${files.length} YAML adapters${ioFailures ? ` (${ioFailures} I/O failures)` : ""}\n`,
  );
  if (ioFailures > 0) process.exit(1);
}

// Only run when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
