#!/usr/bin/env node
/**
 * Release mainline check — blocks releases unless the macOS dynamic discovery
 * work is already on main.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const REQUIRED_BRANCH = "codex/macos-dynamic-actions";
const REQUIRED_COMMIT = "33bafa6087bf81c9b9df5cc0e996e79f6e28f030";
const REQUIRED_FILES = [
  "src/discovery/macos-dynamic.ts",
  "src/adapters/macos/actions.ts",
  "tests/unit/dynamic-macos.test.ts",
];
const REQUIRED_MANIFEST_COMMANDS = ["app-actions", "automation-smoke"];

export interface ReleaseMainlineCheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface ReleaseMainlineCheckOptions {
  requireManifest?: boolean;
}

function git(args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function gitOk(args: string[]): boolean {
  try {
    execFileSync("git", args, {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function currentRefName(): string {
  const refName = process.env.GITHUB_REF_NAME?.trim();
  if (refName) return refName;

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch && branch !== "HEAD") return branch;

  const ref = process.env.GITHUB_REF?.trim();
  if (ref?.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref?.startsWith("refs/tags/")) return ref.slice("refs/tags/".length);

  return "";
}

function isReleaseTagRef(): boolean {
  const ref = process.env.GITHUB_REF?.trim();
  const refName = process.env.GITHUB_REF_NAME?.trim();
  return ref?.startsWith("refs/tags/v") || refName?.startsWith("v") || false;
}

function refMatchesHead(ref: string): boolean {
  const head = git(["rev-parse", "HEAD"]);
  const candidate = git(["rev-parse", "--verify", ref]);
  return Boolean(head && candidate && head === candidate);
}

function fetchOriginMain(): void {
  git(["fetch", "--depth=1", "origin", "main:refs/remotes/origin/main"]);
}

function mainlineRefCheck(): ReleaseMainlineCheckResult {
  const refName = currentRefName();

  if (refName === "main") {
    return {
      name: "Release runs from main",
      pass: true,
      detail: "Current branch is main",
    };
  }

  if (isReleaseTagRef()) {
    const headMatchesMain =
      refMatchesHead("main") ||
      refMatchesHead("origin/main") ||
      (fetchOriginMain(), refMatchesHead("origin/main"));

    return {
      name: "Release runs from main",
      pass: headMatchesMain,
      detail: headMatchesMain
        ? `Current release tag "${refName}" points at main`
        : `Current release tag "${refName || "unknown"}" does not point at main; move the tag to main before publishing`,
    };
  }

  return {
    name: "Release runs from main",
    pass: false,
    detail: `Current ref is "${refName || "unknown"}"; review, merge to main, then release`,
  };
}

function manifestCommands(): string[] | undefined {
  const manifestPath = join(ROOT, "dist", "manifest.json");
  if (!existsSync(manifestPath)) return undefined;

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      sites?: Record<string, { commands?: Array<{ name?: unknown }> }>;
    };
    const commands = manifest.sites?.macos?.commands;
    if (!Array.isArray(commands)) return [];
    return commands
      .map((command) => command.name)
      .filter((name): name is string => typeof name === "string");
  } catch {
    return [];
  }
}

export function collectReleaseMainlineChecks(
  options: ReleaseMainlineCheckOptions = {},
): ReleaseMainlineCheckResult[] {
  const results: ReleaseMainlineCheckResult[] = [];
  results.push(mainlineRefCheck());

  const commitExists = gitOk(["cat-file", "-e", `${REQUIRED_COMMIT}^{commit}`]);
  results.push({
    name: `${REQUIRED_BRANCH} commit exists`,
    pass: commitExists,
    detail: commitExists
      ? `Found ${REQUIRED_COMMIT}`
      : `Missing ${REQUIRED_COMMIT}; fetch main/history before release`,
  });

  const commitInHead =
    commitExists &&
    gitOk(["merge-base", "--is-ancestor", REQUIRED_COMMIT, "HEAD"]);
  results.push({
    name: `${REQUIRED_BRANCH} merged to main`,
    pass: commitInHead,
    detail: commitInHead
      ? `${REQUIRED_COMMIT} is an ancestor of HEAD`
      : `${REQUIRED_BRANCH} is not in HEAD; audit, review, merge to main, then release`,
  });

  for (const file of REQUIRED_FILES) {
    const exists = existsSync(join(ROOT, file));
    results.push({
      name: `${file} present`,
      pass: exists,
      detail: exists
        ? `${file} exists`
        : `${file} missing; macOS dynamic discovery is not release-ready`,
    });
  }

  if (options.requireManifest) {
    const commands = manifestCommands();
    const manifestExists = commands !== undefined;
    results.push({
      name: "Build manifest for macOS commands",
      pass: manifestExists,
      detail: manifestExists
        ? "dist/manifest.json was inspected"
        : "dist/manifest.json missing; run `npm run build` first",
    });

    for (const command of REQUIRED_MANIFEST_COMMANDS) {
      const found = commands?.includes(command) ?? false;
      results.push({
        name: `macos.${command} in manifest`,
        pass: found,
        detail: found
          ? `macos.${command} is in dist/manifest.json`
          : `macos.${command} missing from dist/manifest.json`,
      });
    }
  }

  return results;
}

export function assertReleaseMainline(
  options: ReleaseMainlineCheckOptions = {},
): void {
  const results = collectReleaseMainlineChecks(options);
  const failures = results.filter((result) => !result.pass);

  if (failures.length === 0) return;

  console.error("\n✗ Release mainline gate failed\n");
  for (const failure of failures) {
    console.error(`   ✗ ${failure.name} — ${failure.detail}`);
  }
  console.error(
    `\n   Required: ${REQUIRED_BRANCH} must be audited, reviewed, and merged to main before any release.\n`,
  );
  process.exit(78);
}

function main(): void {
  const requireManifest =
    process.argv.includes("--require-manifest") ||
    process.env.RELEASE_REQUIRE_MANIFEST === "1";
  const results = collectReleaseMainlineChecks({ requireManifest });
  const failures = results.filter((result) => !result.pass);

  console.log("\n🔒 Release Mainline Check\n");
  for (const result of results) {
    console.log(
      `   ${result.pass ? "✓" : "✗"} ${result.name}${result.pass ? "" : ` — ${result.detail}`}`,
    );
  }
  console.log(
    `\n   ${results.length - failures.length} passed, ${failures.length} failed out of ${results.length} checks`,
  );

  if (failures.length > 0) process.exit(78);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
