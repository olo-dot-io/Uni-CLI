/**
 * count-consistency — Fail the build when a tracked release surface drifts from stats.json.
 *
 * Scans README.md, AGENTS.md, docs/ROADMAP.md, internal/TASTE.md for
 * `<!-- STATS:<key> -->...<!-- /STATS -->` markers and asserts the rendered
 * value matches `stats.json[<key>]`. CLAUDE.md is .gitignored and internal —
 * its numbers are intentionally out of scope.
 *
 * Exit:
 *   0  — every marker matches stats.json
 *   1  — at least one mismatch; details on stderr
 *
 * Regenerate stats:  npm run stats
 * Inject into docs:  npm run build  (calls build-readme and build-agents)
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
  join("internal", "TASTE.md"),
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
