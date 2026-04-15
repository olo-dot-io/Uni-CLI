/**
 * Adapter-test coverage gate.
 *
 * For each testable adapter (web-api / service YAML with a pipeline,
 * not quarantined), check that a colocated `.test.ts` file exists next
 * to the YAML. Fail the CI gate when the absolute count of covered
 * adapters drops below the configured floor.
 *
 * Opt-out: an adapter may declare `no_test_reason: <issue-url>` to be
 * excluded from the denominator. Use sparingly — every exclusion is a
 * rigor hole.
 *
 * Quarantined adapters are always excluded from both numerator and
 * denominator.
 *
 * Usage:
 *   npx tsx scripts/check-adapter-test-coverage.ts [--min-covered N] [--json]
 *
 * The legacy `--threshold N` flag is accepted as an alias. The number is
 * the **minimum count of adapters with a colocated test** — not a
 * percentage. The `coverage_pct` field in `--json` output reports the
 * derived ratio for dashboarding.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ADAPTERS_DIR = join(ROOT, "src", "adapters");

interface YamlAdapter {
  site?: string;
  name?: string;
  type?: string;
  pipeline?: unknown[];
  quarantine?: boolean;
  no_test_reason?: string;
}

interface Row {
  site: string;
  cmd: string;
  yamlPath: string;
  hasTest: boolean;
  excluded: boolean;
  excludeReason?: string;
}

function loadYaml(path: string): YamlAdapter | undefined {
  try {
    return yaml.load(readFileSync(path, "utf-8"), {
      schema: yaml.CORE_SCHEMA,
    }) as YamlAdapter;
  } catch {
    return undefined;
  }
}

function walk(): Row[] {
  const rows: Row[] = [];
  if (!existsSync(ADAPTERS_DIR)) return rows;
  for (const site of readdirSync(ADAPTERS_DIR)) {
    if (site.startsWith("_") || site.startsWith(".")) continue;
    const siteDir = join(ADAPTERS_DIR, site);
    if (!statSync(siteDir).isDirectory()) continue;
    for (const file of readdirSync(siteDir)) {
      const ext = extname(file);
      if (ext !== ".yaml" && ext !== ".yml") continue;
      const cmd = file.slice(0, -ext.length);
      if (cmd.startsWith("_")) continue;
      const yamlPath = join(siteDir, file);
      const parsed = loadYaml(yamlPath);
      if (!parsed) continue;
      const type = parsed.type ?? "web-api";
      if (type !== "web-api" && type !== "service") continue;
      if (!Array.isArray(parsed.pipeline)) continue;

      const testPath = join(siteDir, `${cmd}.test.ts`);
      const hasTest = existsSync(testPath);
      const excludeReason = parsed.quarantine
        ? `quarantined`
        : parsed.no_test_reason
          ? `no_test_reason: ${parsed.no_test_reason}`
          : undefined;

      rows.push({
        site,
        cmd,
        yamlPath,
        hasTest,
        excluded: excludeReason !== undefined,
        excludeReason,
      });
    }
  }
  return rows.sort(
    (a, b) => a.site.localeCompare(b.site) || a.cmd.localeCompare(b.cmd),
  );
}

interface Args {
  threshold: number;
  json: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { threshold: 50, json: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--min-covered" || a === "--threshold") {
      out.threshold = Number(argv[++i]);
    } else if (a === "--json") out.json = true;
    else if (a === "--verbose" || a === "-v") out.verbose = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const rows = walk();
const testable = rows.filter((r) => !r.excluded);
const covered = testable.filter((r) => r.hasTest);
const missing = testable.filter((r) => !r.hasTest);

const siteBreakdown: Record<string, { covered: number; testable: number }> = {};
for (const r of testable) {
  const e = (siteBreakdown[r.site] ??= { covered: 0, testable: 0 });
  e.testable++;
  if (r.hasTest) e.covered++;
}

if (args.json) {
  const report = {
    threshold: args.threshold,
    testable: testable.length,
    covered: covered.length,
    missing: missing.length,
    coverage_pct:
      testable.length === 0
        ? 100
        : Math.round((covered.length / testable.length) * 1000) / 10,
    sites: siteBreakdown,
    missing_adapters: missing.map((r) => ({ site: r.site, cmd: r.cmd })),
    excluded_adapters: rows
      .filter((r) => r.excluded)
      .map((r) => ({ site: r.site, cmd: r.cmd, reason: r.excludeReason })),
  };
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`adapter-test coverage — min-covered ${args.threshold}`);
  console.log(
    `  tested: ${covered.length} / ${testable.length} testable (${rows.length - testable.length} excluded)`,
  );
  if (args.verbose) {
    console.log("\n  per-site coverage:");
    const sortedSites = Object.entries(siteBreakdown).sort(
      (a, b) => b[1].covered - a[1].covered,
    );
    for (const [site, { covered: c, testable: t }] of sortedSites) {
      console.log(`    ${site.padEnd(20)} ${c}/${t}`);
    }
    if (missing.length > 0 && missing.length <= 200) {
      console.log("\n  missing:");
      for (const r of missing.slice(0, 50)) {
        console.log(`    ${r.site}/${r.cmd}`);
      }
      if (missing.length > 50) {
        console.log(`    ... and ${missing.length - 50} more`);
      }
    }
  }
}

if (covered.length >= args.threshold) {
  console.log(`\nOK: ${covered.length} >= ${args.threshold}`);
  process.exit(0);
}
console.error(
  `\nFAIL: ${covered.length} colocated tests < threshold ${args.threshold}. ` +
    `Run: npx tsx scripts/bootstrap-adapter-tests.ts --all --with-fixtures`,
);
process.exit(1);
