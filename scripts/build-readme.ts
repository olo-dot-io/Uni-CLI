/**
 * build-readme — Inject stats.json values into public docs.
 *
 * For each file in TARGETS, rewrite every
 *   <!-- STATS:<key> -->...<!-- /STATS -->
 * block so its text content equals `stats.json[<key>]`. Idempotent: running
 * twice is a no-op. CLAUDE.md is .gitignored; its numbers stay manual.
 *
 * Wired into `npm run build` after `scripts/build-manifest.js`. Also runs
 * as part of `npm run stats` so authors see doc diffs immediately.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
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
  join("contributing", "COPY.md"),
];

const MARKER = /<!--\s*STATS:([a-z_]+)\s*-->[\s\S]*?<!--\s*\/STATS\s*-->/g;

function loadStats(): Record<string, unknown> {
  if (!existsSync(STATS_PATH)) {
    console.error(
      "build-readme: stats.json is missing. Run `npm run stats` first.",
    );
    process.exit(1);
  }
  return JSON.parse(readFileSync(STATS_PATH, "utf-8"));
}

export function inject(
  source: string,
  stats: Record<string, unknown>,
): { output: string; changed: number; missing: string[] } {
  const missing: string[] = [];
  let changed = 0;
  const output = source.replace(MARKER, (_full, key: string) => {
    if (!(key in stats)) {
      missing.push(key);
      return `<!-- STATS:${key} -->?<!-- /STATS -->`;
    }
    changed++;
    return `<!-- STATS:${key} -->${String(stats[key])}<!-- /STATS -->`;
  });
  return { output, changed, missing };
}

function main(): void {
  const stats = loadStats();
  let totalChanged = 0;
  const missingAll: Array<{ file: string; keys: string[] }> = [];

  for (const rel of TARGETS) {
    const full = join(ROOT, rel);
    if (!existsSync(full)) continue;
    const source = readFileSync(full, "utf-8");
    const { output, changed, missing } = inject(source, stats);
    if (output !== source) {
      writeFileSync(full, output, "utf-8");
    }
    totalChanged += changed;
    if (missing.length > 0) missingAll.push({ file: rel, keys: missing });
  }

  console.log(
    `build-readme: injected ${totalChanged} STATS marker${totalChanged === 1 ? "" : "s"} across ${TARGETS.length} file${TARGETS.length === 1 ? "" : "s"}`,
  );
  if (missingAll.length > 0) {
    for (const { file, keys } of missingAll) {
      console.error(
        `build-readme: ${file} references unknown stats: ${keys.join(", ")}`,
      );
    }
    process.exit(1);
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFile) {
  main();
}
