/**
 * @owner   tests/unit/agents-sync.test.ts
 * @does    Assert AGENTS.md stays connected to generated catalog markers.
 * @needs   AGENTS.md, stats.json
 * @feeds   Feature 3.5 agent context sync gate, npm run test
 * @breaks  Stale agent context misstates live catalog size or generator ownership.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const AGENTS = join(ROOT, "AGENTS.md");
const STATS = join(ROOT, "stats.json");

const GENERATED_MARKERS = [
  "<!-- BEGIN COUNTS -->",
  "<!-- END COUNTS -->",
  "<!-- BEGIN ADAPTERS -->",
  "<!-- END ADAPTERS -->",
];

interface Stats {
  site_count: number;
  command_count: number;
  pipeline_step_count: number;
}

function agentsText(): string {
  return readFileSync(AGENTS, "utf-8");
}

function stats(): Stats {
  return JSON.parse(readFileSync(STATS, "utf-8")) as Stats;
}

describe("AGENTS.md generated catalog sync", () => {
  it("has marker blocks for generated counts and adapter summary", () => {
    const text = agentsText();

    for (const marker of GENERATED_MARKERS) {
      expect(text, `missing ${marker}`).toContain(marker);
    }
  });

  it("publishes current count markers from stats.json", () => {
    const text = agentsText();
    const current = stats();

    expect(text).toContain(
      `<!-- STATS:site_count -->${current.site_count}<!-- /STATS -->`,
    );
    expect(text).toContain(
      `<!-- STATS:command_count -->${current.command_count}<!-- /STATS -->`,
    );
    expect(text).toContain(
      `<!-- STATS:pipeline_step_count -->${current.pipeline_step_count}<!-- /STATS -->`,
    );
  });
});
