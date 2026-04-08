#!/usr/bin/env tsx
/**
 * Build the canonical adapter catalog at docs/adapters-catalog.json.
 *
 * Runs `loadAllAdapters` (YAML) and `loadTsAdapters` (TS) the same way the
 * CLI does, then walks the registry and writes a single JSON file. This file
 * is the machine-readable manifest published to skill registries and indexed
 * by the docs site.
 *
 * Usage:
 *   tsx scripts/generate-catalog.ts                     # writes default path
 *   tsx scripts/generate-catalog.ts docs/catalog.json   # custom path
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadAllAdapters, loadTsAdapters } from "../src/discovery/loader.js";
import { buildCatalog } from "../src/commands/skills.js";

async function main(): Promise<void> {
  const out = resolve(process.argv[2] ?? "docs/adapters-catalog.json");

  // Load both YAML + TS adapters into the registry.
  loadAllAdapters();
  await loadTsAdapters();

  const catalog = buildCatalog();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(catalog, null, 2), "utf-8");

  process.stdout.write(
    `wrote catalog: ${catalog.total_sites} sites, ${catalog.total_commands} commands → ${out}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `generate-catalog failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
