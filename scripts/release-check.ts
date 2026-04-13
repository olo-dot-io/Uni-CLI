/**
 * Release check — validates version consistency across all release files.
 *
 * Checks:
 * 1. All 7 files contain the current version string
 * 2. CHANGELOG.md has a heading for the current version
 * 3. Build manifest exists at dist/manifest.json
 *
 * Exit 0 if all checks pass, exit 1 with details if not.
 *
 * Usage: npx tsx scripts/release-check.ts
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const version: string = pkg.version;

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: CheckResult[] = [];

// --- Check 1: Version string present in all 7 files ---

const versionFiles = [
  { file: "package.json", pattern: `"version": "${version}"` },
  { file: "CLAUDE.md", pattern: `Version: ${version}` },
  { file: "AGENTS.md", pattern: version },
  { file: "README.md", pattern: version },
  { file: "CHANGELOG.md", pattern: `[${version}]` },
  { file: "docs/TASTE.md", pattern: version },
  { file: "docs/ROADMAP.md", pattern: `v${version}` },
];

for (const { file, pattern } of versionFiles) {
  const filePath = join(ROOT, file);
  if (!existsSync(filePath)) {
    results.push({
      name: `${file} exists`,
      pass: false,
      detail: `File not found: ${file}`,
    });
    continue;
  }
  const content = readFileSync(filePath, "utf-8");
  const found = content.includes(pattern);
  results.push({
    name: `${file} has v${version}`,
    pass: found,
    detail: found
      ? `Found "${pattern}" in ${file}`
      : `Missing "${pattern}" in ${file}`,
  });
}

// --- Check 2: CHANGELOG.md has heading for current version ---

const changelogPath = join(ROOT, "CHANGELOG.md");
if (existsSync(changelogPath)) {
  const changelog = readFileSync(changelogPath, "utf-8");
  const hasHeading = changelog.includes(`## [${version}]`);
  results.push({
    name: "CHANGELOG.md version heading",
    pass: hasHeading,
    detail: hasHeading
      ? `Found heading for v${version}`
      : `No "## [${version}]" heading found in CHANGELOG.md`,
  });
} else {
  results.push({
    name: "CHANGELOG.md version heading",
    pass: false,
    detail: "CHANGELOG.md not found",
  });
}

// --- Check 3: Build manifest exists ---

const manifestPath = join(ROOT, "dist", "manifest.json");
const manifestExists = existsSync(manifestPath);
results.push({
  name: "Build manifest",
  pass: manifestExists,
  detail: manifestExists
    ? "dist/manifest.json exists"
    : "dist/manifest.json not found — run `npm run build` first",
});

// --- Report ---

const failures = results.filter((r) => !r.pass);
const passes = results.filter((r) => r.pass);

console.log(`\n🔍 Release Check — v${version}\n`);

for (const r of passes) {
  console.log(`   ✓ ${r.name}`);
}
for (const r of failures) {
  console.log(`   ✗ ${r.name} — ${r.detail}`);
}

console.log(
  `\n   ${passes.length} passed, ${failures.length} failed out of ${results.length} checks`,
);

if (failures.length > 0) {
  process.exit(1);
}
