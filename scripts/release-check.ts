/**
 * Release check — validates version consistency across release files.
 *
 * Checks:
 * 1. Tracked release files contain the current version string
 * 2. CHANGELOG.md has a heading for the current version
 * 3. Build manifest exists at dist/manifest.json
 * 4. With --strict-codename, release surfaces contain Program · Astronaut
 *
 * Exit 0 if all checks pass, exit 1 with details if not.
 *
 * Usage: npx tsx scripts/release-check.ts [--strict-codename]
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const version: string = pkg.version;
const args = process.argv.slice(2);
const strictCodename =
  args.includes("--strict-codename") ||
  process.env.RELEASE_REQUIRE_CODENAME === "1";

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasFinalCodename(value: string): boolean {
  return (
    /—\s+\S.+\s·\s\S.+/.test(value) &&
    !/\b(?:tbd|todo|unreleased|next)\b/i.test(value)
  );
}

// --- Check 1: Version string present in tracked release files ---

const versionFiles = [
  { file: "package.json", pattern: `"version": "${version}"` },
  { file: "package-lock.json", pattern: `"version": "${version}"` },
  { file: "AGENTS.md", pattern: version },
  { file: "README.md", pattern: version },
  { file: "README.zh-CN.md", pattern: version },
  { file: "CHANGELOG.md", pattern: `[${version}]` },
  { file: "contributing/COPY.md", pattern: version },
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
  const headingPattern = new RegExp(
    `^## \\[${escapeRegExp(version)}\\].*$`,
    "m",
  );
  const heading = changelog.match(headingPattern)?.[0] ?? "";
  const hasHeading = heading.length > 0;
  results.push({
    name: "CHANGELOG.md version heading",
    pass: hasHeading,
    detail: hasHeading
      ? `Found heading for v${version}`
      : `No "## [${version}]" heading found in CHANGELOG.md`,
  });
  if (strictCodename) {
    results.push({
      name: "CHANGELOG.md release codename",
      pass: hasFinalCodename(heading),
      detail: hasFinalCodename(heading)
        ? `Found final codename in "${heading}"`
        : `Heading must include a final Program · Astronaut codename: "${heading || "missing"}"`,
    });
  }
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

// --- Check 4: Strict codename on tracked release surfaces ---

if (strictCodename) {
  const codenameFiles = [
    "README.md",
    "README.zh-CN.md",
    "contributing/COPY.md",
  ];
  for (const file of codenameFiles) {
    const filePath = join(ROOT, file);
    if (!existsSync(filePath)) {
      results.push({
        name: `${file} release codename`,
        pass: false,
        detail: `File not found: ${file}`,
      });
      continue;
    }
    const content = readFileSync(filePath, "utf-8");
    const pass = content.includes(version) && hasFinalCodename(content);
    results.push({
      name: `${file} release codename`,
      pass,
      detail: pass
        ? `Found final codename for v${version}`
        : `Missing final Program · Astronaut codename for v${version}`,
    });
  }
}

// --- Report ---

const failures = results.filter((r) => !r.pass);
const passes = results.filter((r) => r.pass);

console.log(
  `\n🔍 Release Check — v${version}${strictCodename ? " (strict codename)" : ""}\n`,
);

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
