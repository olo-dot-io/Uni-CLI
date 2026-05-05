/**
 * @owner   tests/unit/readme-site-grid.test.ts
 * @does    Assert READMEs expose every active site in the generated coverage grid.
 * @needs   README.md, README.zh-CN.md, dist/manifest.json, archive.json
 * @feeds   README grid gate, npm run test
 * @breaks  Missing active-site coverage in README makes the public project surface stale.
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

function aliveSites(): string[] {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf-8")) as Manifest;
  return Object.entries(manifest.sites)
    .filter(([, site]) =>
      site.commands.every((command) => command.quarantined !== true),
    )
    .map(([site]) => site)
    .sort();
}

describe("README active-site grid", () => {
  it.each(README_TARGETS)(
    "lists every alive manifest site exactly once in $label",
    (target) => {
      const grid = readGrid(target);
      const sites = aliveSites();
      const missing = sites.filter(
        (site) => !grid.includes(`data-site="${site}"`),
      );
      const wrongOccurrences = sites.filter((site) => {
        const occurrences = grid.match(
          new RegExp(
            `data-site="${site.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
            "g",
          ),
        );
        return (occurrences?.length ?? 0) !== 1;
      });

      expect(missing).toEqual([]);
      expect(wrongOccurrences).toEqual([]);
    },
  );

  it.each(README_TARGETS)(
    "does not list archived sites in $label",
    (target) => {
      const grid = readGrid(target);
      const archived = (
        JSON.parse(readFileSync(ARCHIVE, "utf-8")) as ArchiveManifest
      ).sites.map((record) => record.site);

      for (const site of archived) {
        expect(grid, `${target.label} grid still lists ${site}`).not.toContain(
          `data-site="${site}"`,
        );
      }
    },
  );
});
