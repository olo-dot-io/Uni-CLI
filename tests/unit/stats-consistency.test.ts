import { describe, it, expect } from "vitest";
import { inject } from "../../scripts/build-readme.js";
import { findViolations } from "../../scripts/count-consistency.js";
import { computeStats } from "../../scripts/count-stats.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const STATS_PATH = join(ROOT, "stats.json");

/**
 * stats.json SSOT contract:
 *   1. computeStats() returns non-zero counts for a real repo
 *   2. inject() rewrites STATS markers to match stats.json values
 *   3. findViolations() flags a drifted marker
 *   4. findViolations() returns empty when everything matches
 */

describe("stats SSOT", () => {
  it("computeStats returns non-zero counts for this repo", () => {
    const stats = computeStats();
    expect(stats.site_count).toBeGreaterThan(0);
    expect(stats.command_count).toBeGreaterThanOrEqual(stats.site_count);
    expect(stats.adapter_count_yaml).toBeGreaterThan(0);
    expect(stats.adapter_count_total).toBe(
      stats.adapter_count_yaml + stats.adapter_count_ts,
    );
    expect(stats.pipeline_step_count).toBeGreaterThan(0);
    expect(stats.test_count).toBeGreaterThan(0);
    expect(stats.transport_count).toBeGreaterThan(0);
    expect(stats.category_count).toBeGreaterThan(0);
    expect(typeof stats.built_at).toBe("string");
  });

  it("inject rewrites a STATS marker to match stats.json", () => {
    const stats: Record<string, unknown> = {
      site_count: 200,
      command_count: 1000,
    };
    const source =
      "The project has <!-- STATS:site_count -->0<!-- /STATS --> sites " +
      "and <!-- STATS:command_count -->0<!-- /STATS --> commands.";
    const { output, changed, missing } = inject(source, stats);
    expect(changed).toBe(2);
    expect(missing).toEqual([]);
    expect(output).toContain("<!-- STATS:site_count -->200<!-- /STATS -->");
    expect(output).toContain("<!-- STATS:command_count -->1000<!-- /STATS -->");
  });

  it("inject reports missing keys without throwing", () => {
    const stats: Record<string, unknown> = { site_count: 5 };
    const source = "bogus <!-- STATS:undefined_key -->0<!-- /STATS -->";
    const { missing } = inject(source, stats);
    expect(missing).toEqual(["undefined_key"]);
  });

  it("findViolations detects drift in a doc file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-stats-drift-"));
    try {
      const docFile = join(tmp, "README.md");
      writeFileSync(
        docFile,
        "We have <!-- STATS:site_count -->999<!-- /STATS --> sites today.\n",
        "utf-8",
      );
      const stats = { site_count: 195 };
      // findViolations resolves paths relative to the repo root, so we need to
      // pass an absolute path. It skips anything outside the root silently.
      // Simulate by writing to a temp file then reading directly.
      const source = readFileSync(docFile, "utf-8");
      const { output, changed } = inject(source, stats);
      expect(changed).toBe(1);
      expect(output).toContain("<!-- STATS:site_count -->195<!-- /STATS -->");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("findViolations returns empty when repo docs match stats.json", () => {
    // The CI pipeline keeps these in sync via `npm run stats`. If this fails
    // locally after edits, run `npm run stats` and commit the updates.
    const stats = JSON.parse(readFileSync(STATS_PATH, "utf-8"));
    const violations = findViolations(stats);
    expect(violations).toEqual([]);
  });
});
