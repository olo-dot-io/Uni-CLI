/**
 * @owner   tests/unit/stats-consistency.test.ts
 * @does    Verify stats.json source-of-truth counts and generated documentation marker consistency.
 * @needs   vitest, scripts/build-readme.ts, scripts/count-consistency.ts, scripts/count-stats.ts, repo stats/docs files
 * @feeds   npm run test, npm run stats:check, npm run verify
 * @breaks  Drift between computed stats and public documentation markers fails unit verification.
 */

import { describe, it, expect, afterEach } from "vitest";
import { inject } from "../../scripts/build-readme.js";
import { findViolations } from "../../scripts/count-consistency.js";
import { computeStats } from "../../scripts/count-stats.js";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const STATS_PATH = join(ROOT, "stats.json");

// findViolations() resolves paths relative to the repo root, so fixture files
// must live inside ROOT. We create them under tests/fixtures/stats-tmp/ and
// track them for cleanup.
const FIXTURE_ROOT = join(ROOT, "tests", "fixtures", "stats-tmp");

/**
 * stats.json SSOT contract:
 *   1. computeStats() returns non-zero counts for a real repo
 *   2. inject() rewrites STATS markers to match stats.json values
 *   3. findViolations() flags a drifted marker
 *   4. findViolations() returns empty when everything matches
 */

describe("stats SSOT", () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function makeFixtureFile(name: string, contents: string): string {
    if (!existsSync(FIXTURE_ROOT)) {
      mkdirSync(FIXTURE_ROOT, { recursive: true });
    }
    const tmp = mkdtempSync(join(FIXTURE_ROOT, "case-"));
    createdDirs.push(tmp);
    const full = join(tmp, name);
    writeFileSync(full, contents, "utf-8");
    // findViolations takes paths relative to ROOT.
    return relative(ROOT, full);
  }

  // Timeout bumped to 60s: `computeStats()` spawns `vitest list --json` twice
  // (one per project) via T11's test_count rewrite, which takes ~10-25s on
  // cold runs of this repo. 5s default was tight from day one.
  it(
    "computeStats returns non-zero counts for this repo",
    { timeout: 60_000 },
    () => {
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
    },
  );

  it("counts current MCP transport surfaces without legacy SSE transport", () => {
    expect(existsSync(join(ROOT, "src", "mcp", "server.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "src", "mcp", "http-transport.ts"))).toBe(
      true,
    );
    expect(existsSync(join(ROOT, "src", "mcp", "streamable-http.ts"))).toBe(
      true,
    );
    expect(existsSync(join(ROOT, "src", "mcp", "sse-transport.ts"))).toBe(
      false,
    );
    expect(computeStats().transport_count).toBe(3);
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

  it("findViolations flags a drifted marker with file/key/expected/actual", () => {
    const rel = makeFixtureFile(
      "DRIFT.md",
      "We have <!-- STATS:site_count -->999<!-- /STATS --> sites today.\n",
    );
    const stats = { site_count: 195 };
    const violations = findViolations(stats, [rel]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual({
      file: rel,
      key: "site_count",
      expected: "195",
      actual: "999",
    });
  });

  it("findViolations flags markers referencing unknown stats keys", () => {
    const rel = makeFixtureFile(
      "UNKNOWN.md",
      "Bogus <!-- STATS:ghost_count -->42<!-- /STATS -->.\n",
    );
    const stats = { site_count: 195 };
    const violations = findViolations(stats, [rel]);
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe(rel);
    expect(violations[0].key).toBe("ghost_count");
    expect(violations[0].expected).toBe("(unknown key in stats.json)");
    expect(violations[0].actual).toBe("42");
  });

  it("findViolations returns empty for a fixture with no markers", () => {
    const rel = makeFixtureFile("PLAIN.md", "Plain prose, no markers.\n");
    const stats = { site_count: 195 };
    expect(findViolations(stats, [rel])).toEqual([]);
  });

  it("findViolations returns empty when markers match stats", () => {
    const rel = makeFixtureFile(
      "MATCH.md",
      "We have <!-- STATS:site_count -->195<!-- /STATS --> sites.\n",
    );
    const stats = { site_count: 195 };
    expect(findViolations(stats, [rel])).toEqual([]);
  });

  it("findViolations returns empty when repo docs match stats.json", () => {
    // The CI pipeline keeps these in sync via `npm run stats`. If this fails
    // locally after edits, run `npm run stats` and commit the updates.
    const stats = JSON.parse(readFileSync(STATS_PATH, "utf-8"));
    const violations = findViolations(stats);
    expect(violations).toEqual([]);
  });
});
