/**
 * @owner   tests/unit/readme-site-grid.test.ts
 * @does    Assert README coverage grids expose only logo-backed manifest sites.
 * @needs   README.md, README.zh-CN.md, dist/manifest.json, archive.json
 * @feeds   README grid gate, npm run test
 * @breaks  Placeholder badges make the public project surface look stale.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const MANIFEST = join(ROOT, "dist", "manifest.json");
const ARCHIVE = join(ROOT, "src", "adapters", "_archived", "archive.json");
const README_TARGETS = [
  { label: "English README", path: join(ROOT, "README.md") },
  { label: "Chinese README", path: join(ROOT, "README.zh-CN.md") },
];

const GRID_START = "<!-- BEGIN README_SITE_GRID -->";
const GRID_END = "<!-- END README_SITE_GRID -->";

interface ManifestCommand {
  quarantined?: boolean;
}

interface ManifestSite {
  commands: ManifestCommand[];
}

interface Manifest {
  sites: Record<string, ManifestSite>;
}

interface ArchiveManifest {
  sites: Array<{ site: string }>;
}

const ARCHIVE_ONLY_SITES = new Set(["apple-music", "az", "gcloud"]);

function readGrid(target: { label: string; path: string }): string {
  const readme = readFileSync(target.path, "utf-8");
  const start = readme.indexOf(GRID_START);
  const end = readme.indexOf(GRID_END);

  expect(
    start,
    `${target.label} site grid start marker`,
  ).toBeGreaterThanOrEqual(0);
  expect(end, `${target.label} site grid end marker`).toBeGreaterThan(start);

  return readme.slice(start, end);
}

interface SiteRecord {
  site: string;
  commandCount: number;
}

function manifestSites(): Map<string, SiteRecord> {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf-8")) as Manifest;
  return new Map(
    Object.entries(manifest.sites).map(([site, info]) => [
      site,
      {
        site,
        commandCount: info.commands.filter(
          (command) => command.quarantined !== true,
        ).length,
      },
    ]),
  );
}

function listedSites(grid: string): string[] {
  return [...grid.matchAll(/data-site="([^"]+)"/g)].map((match) => match[1]);
}

function commandCountFor(site: string): number {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf-8")) as Manifest;
  const info = manifest.sites[site];
  expect(info, `manifest entry for ${site}`).toBeDefined();
  return info.commands.filter((command) => command.quarantined !== true).length;
}

describe("README active-site grid", () => {
  it.each(README_TARGETS)(
    "lists each displayed manifest site exactly once in $label",
    (target) => {
      const grid = readGrid(target);
      const knownSites = manifestSites();
      const sites = listedSites(grid);
      const unknown = sites.filter((site) => !knownSites.has(site));
      const wrongOccurrences = [...new Set(sites)].filter((site) => {
        const occurrences = grid.match(
          new RegExp(
            `data-site="${site.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
            "g",
          ),
        );
        return (occurrences?.length ?? 0) !== 1;
      });

      expect(unknown).toEqual([]);
      expect(wrongOccurrences).toEqual([]);
    },
  );

  it.each(README_TARGETS)(
    "uses non-quarantined command counts for displayed sites in $label",
    (target) => {
      const grid = readGrid(target);

      for (const site of listedSites(grid)) {
        const commandCount = commandCountFor(site);
        const suffix = commandCount === 1 ? "command" : "commands";
        expect(grid, `${target.label} grid count for ${site}`).toContain(
          `title="${site}: ${commandCount} ${suffix}"`,
        );
      }
    },
  );

  it.each(README_TARGETS)(
    "uses real logo-backed badges in $label",
    (target) => {
      const grid = readGrid(target);
      const badges = [
        ...grid.matchAll(
          /<a data-site="([^"]+)"[\s\S]*?<img [^>]*src="([^"]+)"/g,
        ),
      ];

      expect(
        badges.length,
        `${target.label} displayed badge count`,
      ).toBeGreaterThan(20);
      for (const [, site, src] of badges) {
        expect(src, `${target.label} ${site} badge logo`).toContain("logo=");
        expect(src, `${target.label} ${site} badge logo color`).toContain(
          "logoColor=white",
        );
      }
    },
  );

  it.each(README_TARGETS)(
    "does not list archived sites in $label",
    (target) => {
      const grid = readGrid(target);
      const archived = (
        JSON.parse(readFileSync(ARCHIVE, "utf-8")) as ArchiveManifest
      ).sites
        .map((record) => record.site)
        .filter((site) => ARCHIVE_ONLY_SITES.has(site));

      for (const site of archived) {
        expect(grid, `${target.label} grid still lists ${site}`).not.toContain(
          `data-site="${site}"`,
        );
      }
    },
  );
});
