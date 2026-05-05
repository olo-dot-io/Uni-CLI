/**
 * @owner   tests/unit/readme-site-grid.test.ts
 * @does    Assert README exposes every active site in the generated coverage grid.
 * @needs   README.md, dist/manifest.json, src/adapters/_archived/archive.json
 * @feeds   Feature 3.4 README grid gate, npm run test
 * @breaks  Missing active-site coverage in README makes the public project surface stale.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const README = join(ROOT, "README.md");
const MANIFEST = join(ROOT, "dist", "manifest.json");
const ARCHIVE = join(ROOT, "src", "adapters", "_archived", "archive.json");

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

function readGrid(): string {
  const readme = readFileSync(README, "utf-8");
  const start = readme.indexOf(GRID_START);
  const end = readme.indexOf(GRID_END);

  expect(start, "README site grid start marker").toBeGreaterThanOrEqual(0);
  expect(end, "README site grid end marker").toBeGreaterThan(start);

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
  it("lists every alive manifest site exactly once", () => {
    const grid = readGrid();
    const missing = aliveSites().filter(
      (site) => !grid.includes(`data-site="${site}"`),
    );

    expect(missing).toEqual([]);
  });

  it("does not list archived sites", () => {
    const grid = readGrid();
    const archived = (
      JSON.parse(readFileSync(ARCHIVE, "utf-8")) as ArchiveManifest
    ).sites.map((record) => record.site);

    for (const site of archived) {
      expect(grid, `README grid still lists ${site}`).not.toContain(
        `data-site="${site}"`,
      );
    }
  });
});
