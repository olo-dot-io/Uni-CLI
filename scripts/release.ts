/**
 * Release script — single source of truth propagation.
 *
 * Reads version from package.json and updates ALL documentation references.
 * Run after `npm version X.Y.Z` to propagate the new version everywhere.
 *
 * Usage: npx tsx scripts/release.ts [--codename "Name"] [--dry-run]
 *
 * What it updates:
 * - CLAUDE.md: Version line
 * - AGENTS.md: Version header + site/command counts
 * - README.md: Badge counts + footer codename
 * - docs/TASTE.md: Current version line
 * - docs/VERSIONING.md: Release history table (appends new row)
 *
 * What it does NOT update (read from package.json at runtime):
 * - src/cli.ts — imports VERSION from constants.ts
 * - src/engine/yaml-runner.ts — imports USER_AGENT from constants.ts
 * - scripts/build-manifest.js — reads package.json directly
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// --- Read source of truth ---

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const version: string = pkg.version;
const versionShort = version.split(".").slice(0, 2).join(".");

// Parse CLI args
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const codenameIdx = args.indexOf("--codename");
const codename = codenameIdx >= 0 ? args[codenameIdx + 1] : undefined;

// Read manifest for site/command counts
const manifestPath = join(ROOT, "dist", "manifest.json");
let siteCount = "?";
let cmdCount = "?";
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const sites = Object.keys(manifest.sites || {});
  siteCount = String(sites.length);
  cmdCount = String(
    sites.reduce(
      (sum: number, s: string) =>
        sum + (manifest.sites[s]?.commands?.length || 0),
      0,
    ),
  );
}

// --- Replacement rules ---

interface Rule {
  file: string;
  pattern: RegExp;
  replacement: string;
  description: string;
}

const rules: Rule[] = [
  {
    file: "CLAUDE.md",
    pattern: /^- Version: .+$/m,
    replacement: `- Version: ${version}`,
    description: "CLAUDE.md version line",
  },
  {
    file: "AGENTS.md",
    pattern: /^## Available Sites \(.+\)$/m,
    replacement: `## Available Sites (${version})`,
    description: "AGENTS.md version header",
  },
  {
    file: "AGENTS.md",
    pattern: /^\d+ sites, \d+ commands\./m,
    replacement: `${siteCount} sites, ${cmdCount} commands.`,
    description: "AGENTS.md site/command counts",
  },
  {
    file: "README.md",
    pattern: /\d+_Sites-\d+_Commands/,
    replacement: `${siteCount}_Sites-${cmdCount}_Commands`,
    description: "README.md badge counts",
  },
  {
    file: "docs/TASTE.md",
    pattern: /^Current: .+$/m,
    replacement: codename
      ? `Current: \`${versionShort}.x\` — Mission ${version.split(".")[1].replace(/\d$/, "00")}, codename **${codename}**.`
      : `Current: \`${versionShort}.x\` — Mission ${version.split(".")[1].replace(/\d$/, "00")}.`,
    description: "TASTE.md current version",
  },
];

// README footer — only update if codename provided
if (codename) {
  rules.push({
    file: "README.md",
    pattern: /<sub>v[\d.]+\s*·\s*Codename\s*<strong>.+?<\/strong>.+?<\/sub>/,
    replacement: `<sub>v${version} · Codename <strong>${codename}</strong> — ${siteCount} sites, ${cmdCount} commands</sub>`,
    description: "README.md footer codename",
  });
}

// --- Apply rules ---

console.log(`\n📦 Uni-CLI Release Propagation`);
console.log(`   Version: ${version}`);
console.log(`   Sites: ${siteCount} | Commands: ${cmdCount}`);
if (codename) console.log(`   Codename: ${codename}`);
if (dryRun) console.log(`   Mode: DRY RUN (no writes)\n`);
else console.log();

let updated = 0;
let skipped = 0;

for (const rule of rules) {
  const filePath = join(ROOT, rule.file);
  if (!existsSync(filePath)) {
    console.log(`   ⚠ SKIP ${rule.file} — file not found`);
    skipped++;
    continue;
  }

  const content = readFileSync(filePath, "utf-8");
  if (!rule.pattern.test(content)) {
    console.log(`   ⚠ SKIP ${rule.description} — pattern not found`);
    skipped++;
    continue;
  }

  const newContent = content.replace(rule.pattern, rule.replacement);
  if (newContent === content) {
    console.log(`   ✓ ${rule.description} — already up to date`);
    continue;
  }

  if (!dryRun) {
    writeFileSync(filePath, newContent);
  }
  console.log(`   ${dryRun ? "→" : "✓"} ${rule.description}`);
  updated++;
}

console.log(
  `\n   ${updated} updated, ${skipped} skipped${dryRun ? " (dry run)" : ""}`,
);

if (!dryRun && updated > 0) {
  console.log(`\n   Next steps:`);
  console.log(`   1. Review changes: git diff`);
  console.log(`   2. Commit: git commit -am "chore: release v${version}"`);
  console.log(`   3. Push: git push origin main`);
}
