/**
 * @owner   scripts/count-consistency.ts
 * @does    Fail the build when tracked release surfaces drift from stats.json.
 * @needs   stats.json, docs and README STATS markers
 * @feeds   npm run stats:check, npm run verify
 * @breaks  Public docs can ship stale generated catalog counts.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const STATS_PATH = join(ROOT, "stats.json");

const TARGETS = [
  "README.md",
  "README.zh-CN.md",
  "AGENTS.md",
  join("docs", "ROADMAP.md"),
  join("docs", "zh", "ROADMAP.md"),
  join("docs", "ARCHITECTURE.md"),
  join("docs", "THEORY.md"),
  join("docs", "how-it-works.md"),
  join("docs", "faq.md"),
  join("docs", "zh", "BENCHMARK.md"),
  join("docs", "zh", "how-it-works.md"),
  join("docs", "zh", "faq.md"),
  join("docs", "zh", "glossary.md"),
  join("contributing", "COPY.md"),
];

const MARKER = /<!--\s*STATS:([a-z_]+)\s*-->([\s\S]*?)<!--\s*\/STATS\s*-->/g;

interface Violation {
  file: string;
  key: string;
  expected: string;
  actual: string;
}

function loadStats(): Record<string, unknown> {
  if (!existsSync(STATS_PATH)) {
    console.error(
      "count-consistency: stats.json is missing. Run `npm run stats` first.",
    );
    process.exit(1);
  }
  return JSON.parse(readFileSync(STATS_PATH, "utf-8"));
}

export function findViolations(
  stats: Record<string, unknown>,
  files: string[] = TARGETS,
): Violation[] {
  const violations: Violation[] = [];
  for (const rel of files) {
    const full = join(ROOT, rel);
    if (!existsSync(full)) continue;
    const source = readFileSync(full, "utf-8");
    MARKER.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MARKER.exec(source)) !== null) {
      const key = m[1];
      const rendered = m[2].trim();
      if (!(key in stats)) {
        violations.push({
          file: rel,
          key,
          expected: "(unknown key in stats.json)",
          actual: rendered,
        });
        continue;
      }
      const expected = String(stats[key]);
      if (rendered !== expected) {
        violations.push({ file: rel, key, expected, actual: rendered });
      }
    }
  }
  return violations;
}

function main(): void {
  const stats = loadStats();
  const violations = findViolations(stats);
  if (violations.length === 0) {
    console.log("count-consistency: PASS — all STATS markers match stats.json");
    return;
  }
  for (const v of violations) {
    console.error(
      `count-consistency: FAIL ${v.file}  STATS:${v.key}  expected=${v.expected}  actual=${v.actual}`,
    );
  }
  console.error(
    `count-consistency: ${violations.length} mismatch${violations.length === 1 ? "" : "es"} — run \`npm run build\` to re-inject.`,
  );
  process.exit(1);
}

// Run only when invoked directly
const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFile) {
  main();
}
