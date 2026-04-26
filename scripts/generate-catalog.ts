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

type CatalogCommand = {
  name: string;
  description?: string;
  when_to_use?: string;
  command: string;
};

type CatalogAdapter = {
  site: string;
  type: string;
  domain?: string;
  auth?: boolean;
  strategy?: string;
  commands: CatalogCommand[];
};

function buildDocsSiteIndex(catalog: {
  generated: string;
  total_sites: number;
  total_commands: number;
  adapters: CatalogAdapter[];
}) {
  return {
    generated: catalog.generated,
    total_sites: catalog.total_sites,
    total_commands: catalog.total_commands,
    sites: catalog.adapters.map((adapter) => ({
      site: adapter.site,
      type: adapter.type,
      domain: adapter.domain,
      auth: adapter.auth ?? false,
      strategy: adapter.strategy,
      command_count: adapter.commands.length,
      commands: adapter.commands.map((command) => ({
        name: command.name,
        description: command.description ?? command.when_to_use ?? command.name,
        command: command.command,
      })),
    })),
  };
}

async function main(): Promise<void> {
  const out = resolve(process.argv[2] ?? "docs/adapters-catalog.json");
  const siteIndexOut = resolve("docs/site-index.json");

  // Load both YAML + TS adapters into the registry.
  loadAllAdapters();
  await loadTsAdapters();

  const catalog = buildCatalog();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(catalog, null, 2), "utf-8");
  writeFileSync(
    siteIndexOut,
    JSON.stringify(buildDocsSiteIndex(catalog), null, 2),
    "utf-8",
  );

  process.stdout.write(
    `wrote catalog: ${catalog.total_sites} sites, ${catalog.total_commands} commands → ${out}\n`,
  );
  process.stdout.write(`wrote docs site index → ${siteIndexOut}\n`);
}

main().catch((err) => {
  process.stderr.write(
    `generate-catalog failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
