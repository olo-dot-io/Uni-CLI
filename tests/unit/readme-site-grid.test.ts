/**
 * @owner   tests/unit/readme-site-grid.test.ts
 * @does    Assert README coverage summaries are compact and derived from the active manifest.
 * @needs   README.md, README.zh-CN.md, dist/manifest.json
 * @feeds   README catalog presentation gate, npm run test
 * @breaks  A stale summary can misstate the shipped site or operation totals.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const MANIFEST = join(ROOT, "dist", "manifest.json");
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
  category?: string;
  commands: ManifestCommand[];
}

interface Manifest {
  sites: Record<string, ManifestSite>;
}

function readGrid(target: { label: string; path: string }): string {
  const readme = readFileSync(target.path, "utf-8");
  const start = readme.indexOf(GRID_START);
  const end = readme.indexOf(GRID_END);

  expect(start, `${target.label} start marker`).toBeGreaterThanOrEqual(0);
  expect(end, `${target.label} end marker`).toBeGreaterThan(start);
  expect(readme.indexOf(GRID_START, start + GRID_START.length)).toBe(-1);
  expect(readme.indexOf(GRID_END, end + GRID_END.length)).toBe(-1);

  return readme.slice(start, end + GRID_END.length);
}

function activeManifest() {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf-8")) as Manifest;
  const sites = Object.entries(manifest.sites)
    .map(([site, info]) => ({
      site,
      category: info.category ?? "other",
      commands: info.commands.filter((command) => command.quarantined !== true)
        .length,
    }))
    .filter((entry) => entry.commands > 0);

  return {
    sites,
    siteCount: sites.length,
    commandCount: sites.reduce((sum, entry) => sum + entry.commands, 0),
    categoryCount: new Set(sites.map((entry) => entry.category)).size,
  };
}

function summaryRows(grid: string): Array<{ sites: number; commands: number }> {
  return grid
    .split("\n")
    .filter((line) => /^\| (?!-{3}|Surface|类别)/.test(line))
    .map((line) => {
      const cells = line.split("|").map((cell) => cell.trim());
      return { sites: Number(cells[2]), commands: Number(cells[3]) };
    });
}

describe("README active-site summary", () => {
  it.each(README_TARGETS)(
    "matches manifest totals and category count in $label",
    (target) => {
      const grid = readGrid(target);
      const manifest = activeManifest();
      const rows = summaryRows(grid);

      expect(rows).toHaveLength(manifest.categoryCount);
      expect(rows.reduce((sum, row) => sum + row.sites, 0)).toBe(
        manifest.siteCount,
      );
      expect(rows.reduce((sum, row) => sum + row.commands, 0)).toBe(
        manifest.commandCount,
      );
    },
  );

  it.each(README_TARGETS)(
    "uses manifest-backed example links without a remote badge wall in $label",
    (target) => {
      const grid = readGrid(target);
      const manifestSites = new Set(
        activeManifest().sites.map(({ site }) => site),
      );
      const examples = [
        ...grid.matchAll(
          /\[([^\]]+)\]\(https:\/\/olo-dot-io\.github\.io\/Uni-CLI\/reference\/sites#([^)]+)\)/g,
        ),
      ];

      expect(examples.length).toBeGreaterThan(20);
      for (const [, label, anchor] of examples) {
        expect(label).toBe(anchor);
        expect(manifestSites.has(anchor), `manifest entry for ${anchor}`).toBe(
          true,
        );
      }
      expect(grid).not.toContain("<img");
      expect(grid).not.toContain("shields.io");
    },
  );
});
