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
 * - CHANGELOG.md: Insert new version heading (content added manually)
 * - docs/ROADMAP.md: Update site/command counts
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

// --- CHANGELOG.md: insert version heading if missing ---

const changelogPath = join(ROOT, "CHANGELOG.md");
if (existsSync(changelogPath)) {
  const changelog = readFileSync(changelogPath, "utf-8");
  const versionHeading = `## [${version}]`;
  if (changelog.includes(versionHeading)) {
    console.log(`   ✓ CHANGELOG.md — heading for ${version} already exists`);
  } else {
    const today = new Date().toISOString().slice(0, 10);
    const label = codename || "Unreleased";
    const newHeading = `## [${version}] — ${today} — ${label}\n\n### Added\n\n### Changed\n\n### Fixed\n\n`;
    // Insert after the first line that starts with "# " (the main title block)
    const insertIdx = changelog.indexOf("\n\n## ");
    if (insertIdx >= 0) {
      const before = changelog.slice(0, insertIdx);
      const after = changelog.slice(insertIdx);
      const newChangelog = `${before}\n\n${newHeading}${after.slice(2)}`;
      if (!dryRun) {
        writeFileSync(changelogPath, newChangelog);
      }
      console.log(
        `   ${dryRun ? "→" : "✓"} CHANGELOG.md — inserted heading for v${version}`,
      );
      updated++;
    } else {
      console.log(`   ⚠ SKIP CHANGELOG.md — could not find insertion point`);
      skipped++;
    }
  }
} else {
  console.log(`   ⚠ SKIP CHANGELOG.md — file not found`);
  skipped++;
}

// --- docs/ROADMAP.md: update site/command counts ---

const roadmapPath = join(ROOT, "docs", "ROADMAP.md");
if (existsSync(roadmapPath) && siteCount !== "?" && cmdCount !== "?") {
  let roadmap = readFileSync(roadmapPath, "utf-8");
  let roadmapUpdated = false;

  // Update the summary line like "198 sites, 1020 commands as of v0.211.2"
  const summaryPattern = /\d+ sites, \d+ commands as of v[\d.]+/;
  if (summaryPattern.test(roadmap)) {
    roadmap = roadmap.replace(
      summaryPattern,
      `${siteCount} sites, ${cmdCount} commands as of v${version}`,
    );
    roadmapUpdated = true;
  }

  if (roadmapUpdated) {
    if (!dryRun) {
      writeFileSync(roadmapPath, roadmap);
    }
    console.log(
      `   ${dryRun ? "→" : "✓"} docs/ROADMAP.md — updated site/command counts`,
    );
    updated++;
  } else {
    console.log(
      `   ✓ docs/ROADMAP.md — no count patterns found, skipping gracefully`,
    );
  }
} else if (!existsSync(roadmapPath)) {
  console.log(`   ⚠ SKIP docs/ROADMAP.md — file not found`);
  skipped++;
} else {
  console.log(`   ⚠ SKIP docs/ROADMAP.md — manifest counts unavailable`);
  skipped++;
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
