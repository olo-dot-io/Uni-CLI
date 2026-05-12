/**
 * @owner   tests/unit/site-archive.test.ts
 * @does    Assert dead-site archives stay outside active adapter discovery while retaining auditable provenance.
 * @needs   dist/manifest.json, src/adapters/_archived/archive.json, archived adapter files
 * @feeds   Feature 3.2 dead-site archive gate, npm run test
 * @breaks  Missing archive records or active archive-only sites leave dead adapters in public discovery.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const ACTIVE_MANIFEST = join(ROOT, "dist", "manifest.json");
const ARCHIVE_MANIFEST = join(
  ROOT,
  "src",
  "adapters",
  "_archived",
  "archive.json",
);
const PUBLIC_TEXT_CATALOGS = [
  "docs/public/llms-full.txt",
  "docs/public/markdown/reference/sites.md",
  "docs/public/markdown/zh/reference/sites.md",
] as const;
const PUBLIC_JSON_CATALOGS = [
  { relPath: "docs/adapters-catalog.json", entriesKey: "adapters" },
  { relPath: "docs/site-index.json", entriesKey: "sites" },
] as const;

interface ArchiveRecord {
  site: string;
  commands: string[];
  original_paths: string[];
  archived_paths: string[];
}

interface ActiveCommand {
  name: string;
  quarantined?: boolean;
}

interface ActiveManifest {
  sites: Record<string, { commands: ActiveCommand[] }>;
}

interface PublicCatalogEntry {
  site?: string;
}

interface PublicCatalogJson {
  adapters?: PublicCatalogEntry[];
  sites?: PublicCatalogEntry[];
}

const EXPECTED_ARCHIVE = [
  ["apple-music", ["rate-album"]],
  ["az", ["account"]],
  ["ctrip", ["hot", "search"]],
  ["gcloud", ["projects"]],
] as const;
const ARCHIVE_ONLY_SITES = ["apple-music", "az", "gcloud"] as const;

function readArchive(): ArchiveRecord[] {
  if (!existsSync(ARCHIVE_MANIFEST)) {
    throw new Error(`${ARCHIVE_MANIFEST} is missing`);
  }
  const parsed = JSON.parse(readFileSync(ARCHIVE_MANIFEST, "utf-8")) as {
    sites?: ArchiveRecord[];
  };
  if (!Array.isArray(parsed.sites)) {
    throw new Error(`${ARCHIVE_MANIFEST} must expose a sites array`);
  }
  return parsed.sites;
}

function readActiveManifest(): ActiveManifest {
  return JSON.parse(readFileSync(ACTIVE_MANIFEST, "utf-8")) as ActiveManifest;
}

function readPublicCatalogEntries(
  catalog: (typeof PUBLIC_JSON_CATALOGS)[number],
): PublicCatalogEntry[] {
  const parsed = JSON.parse(
    readFileSync(join(ROOT, catalog.relPath), "utf-8"),
  ) as PublicCatalogJson;
  const entries = parsed[catalog.entriesKey];

  if (!Array.isArray(entries)) {
    throw new Error(
      `${catalog.relPath} must expose a ${catalog.entriesKey} array`,
    );
  }

  return entries;
}

function commandPattern(command: string): RegExp {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}(?=$|[\\s<\`|,.)])`);
}

describe("dead-site archive", () => {
  it("records the dead sites archived by Feature 3.2", () => {
    const archived = readArchive().map((record) => [
      record.site,
      record.commands,
    ]);

    expect(archived).toEqual(EXPECTED_ARCHIVE);
  });

  it("moves archived adapter YAMLs out of active discovery paths", () => {
    for (const record of readArchive()) {
      for (const activePath of record.original_paths) {
        expect(existsSync(join(ROOT, activePath))).toBe(false);
      }
      for (const archivedPath of record.archived_paths) {
        expect(archivedPath).toContain("src/adapters/_archived/");
        expect(existsSync(join(ROOT, archivedPath))).toBe(true);
      }
    }
  });

  it("does not expose archive-only sites in the active manifest", () => {
    const active = readActiveManifest();

    for (const site of ARCHIVE_ONLY_SITES) {
      expect(active.sites[site]).toBeUndefined();
    }
  });

  it("has no active manifest sites with only quarantined commands", () => {
    const active = readActiveManifest();
    const archiveOnlySites = Object.entries(active.sites)
      .filter(([, site]) => {
        const commands = site.commands ?? [];
        return (
          commands.length > 0 &&
          commands.every((command) => command.quarantined === true)
        );
      })
      .map(([site]) => site)
      .sort();

    expect(archiveOnlySites).toEqual([]);
  });

  it("does not advertise archived commands in public catalogs", () => {
    const active = readActiveManifest();
    const activeCommands = new Set(
      Object.entries(active.sites).flatMap(([site, info]) =>
        (info.commands ?? []).map(
          (command) => `unicli ${site} ${command.name}`,
        ),
      ),
    );
    const archivedCommands = readArchive()
      .flatMap((record) =>
        record.commands.map((command) => `unicli ${record.site} ${command}`),
      )
      .filter((command) => !activeCommands.has(command));

    for (const relPath of PUBLIC_TEXT_CATALOGS) {
      const body = readFileSync(join(ROOT, relPath), "utf-8");
      for (const command of archivedCommands) {
        expect(body, `${relPath} still advertises ${command}`).not.toMatch(
          commandPattern(command),
        );
      }
    }

    const archivedSites = new Set(ARCHIVE_ONLY_SITES);
    for (const catalog of PUBLIC_JSON_CATALOGS) {
      const entries = readPublicCatalogEntries(catalog);
      expect(
        entries.length,
        `${catalog.relPath} catalog parser returned no entries`,
      ).toBeGreaterThan(0);
      const leaked = entries
        .map((entry) => entry.site)
        .filter((site): site is string => Boolean(site))
        .filter((site) => archivedSites.has(site))
        .sort();

      expect(leaked, `${catalog.relPath} still lists archived sites`).toEqual(
        [],
      );
    }
  });
});
