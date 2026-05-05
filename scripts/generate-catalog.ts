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
 *   tsx scripts/generate-catalog.ts
 *   tsx scripts/generate-catalog.ts docs/catalog.json
 *   tsx scripts/generate-catalog.ts docs/catalog.json docs/site-index.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { format } from "prettier";
import { loadAllAdapters, loadTsAdapters } from "../src/discovery/loader.js";
import { buildCatalog } from "../src/commands/skills.js";
import { publicEnglishDescription } from "./public-docs-text.js";

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

type GeneratedJson = {
  generated: string;
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
        description: publicEnglishDescription(
          command.description ?? command.when_to_use,
          command.name,
        ),
        command: command.command,
      })),
    })),
  };
}

function readGeneratedJson(path: string): GeneratedJson | undefined {
  if (!existsSync(path)) {
    return undefined;
  }

  const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
    generated?: unknown;
  };
  if (typeof parsed.generated !== "string") {
    throw new Error(`${path} is missing a string generated field`);
  }
  return parsed as GeneratedJson;
}

function contentFingerprint(value: GeneratedJson): string {
  const { generated: _generated, ...content } = value;
  return JSON.stringify(content);
}

function contentUnchanged(
  existing: GeneratedJson | undefined,
  next: GeneratedJson,
): boolean {
  return (
    existing !== undefined &&
    contentFingerprint(existing) === contentFingerprint(next)
  );
}

function chooseGeneratedTimestamp(
  catalog: ReturnType<typeof buildCatalog>,
  siteIndex: ReturnType<typeof buildDocsSiteIndex>,
  catalogPath: string,
  siteIndexPath: string,
): string {
  const existingCatalog = readGeneratedJson(catalogPath);
  const existingSiteIndex = readGeneratedJson(siteIndexPath);

  if (
    contentUnchanged(existingCatalog, catalog) &&
    contentUnchanged(existingSiteIndex, siteIndex)
  ) {
    return existingCatalog.generated;
  }

  return catalog.generated;
}

function defaultSiteIndexPath(catalogOut: string, hasCatalogArg: boolean) {
  if (!hasCatalogArg) {
    return "docs/site-index.json";
  }

  const extension = extname(catalogOut) || ".json";
  const name = basename(catalogOut, extension);
  return join(dirname(catalogOut), `${name}.site-index${extension}`);
}

async function main(): Promise<void> {
  const catalogArg = process.argv[2];
  const out = resolve(catalogArg ?? "docs/adapters-catalog.json");
  const siteIndexOut = resolve(
    process.argv[3] ?? defaultSiteIndexPath(out, Boolean(catalogArg)),
  );

  // Published docs must be reproducible on every machine. Runtime-only
  // macOS discovery depends on the current user's Shortcuts/App Intents, so
  // catalog generation pins the loader to the committed static adapter set.
  process.env.UNICLI_DYNAMIC_MACOS = "0";

  // Load both YAML + TS adapters into the registry.
  loadAllAdapters();
  await loadTsAdapters();

  const catalog = buildCatalog();
  const candidateSiteIndex = buildDocsSiteIndex(catalog);
  catalog.generated = chooseGeneratedTimestamp(
    catalog,
    candidateSiteIndex,
    out,
    siteIndexOut,
  );
  const siteIndex = buildDocsSiteIndex(catalog);
  mkdirSync(dirname(out), { recursive: true });
  mkdirSync(dirname(siteIndexOut), { recursive: true });
  writeFileSync(
    out,
    await format(JSON.stringify(catalog), { parser: "json" }),
    "utf-8",
  );
  writeFileSync(
    siteIndexOut,
    await format(JSON.stringify(siteIndex), { parser: "json" }),
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
