#!/usr/bin/env node
/**
 * verify-changesets — gate that requires a `.changeset/*.md` entry on any
 * PR that modifies `src/`.
 *
 * Why: production code changes must ship with a versioned, user-facing note.
 * Documentation, tests, CI, and tooling changes are exempt.
 *
 * Behavior:
 *   - Runs in any directory; resolves the repo root via git.
 *   - Compares HEAD against the merge base of the configured base branch
 *     (defaults to `origin/main`, override with `BASE_REF`).
 *   - If diff touches `src/` and no new `.changeset/*.md` exists, exit 1.
 *   - On `main` (push event) the gate is a no-op — Changesets release flow
 *     is consumed by the release workflow, not enforced retroactively.
 *
 * Exit codes follow sysexits.h:
 *   0 — pass (no src/ changes, or changeset present, or running on main)
 *   1 — fail (src/ changed without a changeset)
 *   2 — usage / git error
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

function sh(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8" }).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`git failed: ${cmd}\n${msg}`);
  }
}

function repoRoot(): string {
  return sh("git rev-parse --show-toplevel");
}

function currentBranch(): string {
  // GitHub Actions push events run on detached HEAD; fall back to GITHUB_REF_NAME.
  if (process.env.GITHUB_REF_NAME) return process.env.GITHUB_REF_NAME;
  return sh("git rev-parse --abbrev-ref HEAD");
}

function resolveBaseRef(): string {
  const explicit = process.env.BASE_REF;
  if (explicit) return explicit;
  // Prefer origin/main if available, else local main, else fall back to HEAD~1.
  for (const candidate of ["origin/main", "main"]) {
    try {
      sh(`git rev-parse --verify ${candidate}`);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return "HEAD~1";
}

function changedFiles(baseRef: string): string[] {
  let base: string;
  try {
    base = sh(`git merge-base ${baseRef} HEAD`);
  } catch {
    // No common ancestor — treat as "everything changed since base".
    base = baseRef;
  }
  const out = sh(`git diff --name-only ${base}...HEAD`);
  return out ? out.split("\n").filter(Boolean) : [];
}

function main(): void {
  const root = repoRoot();
  process.chdir(root);

  const branch = currentBranch();
  if (branch === "main" || branch === "master") {
    console.log("verify:changesets — skipped on default branch");
    process.exit(0);
  }

  const baseRef = resolveBaseRef();
  const files = changedFiles(baseRef);

  if (files.length === 0) {
    console.log("verify:changesets — no diff vs", baseRef);
    process.exit(0);
  }

  const touchesSrc = files.some(
    (f) => f.startsWith("src/") && !f.startsWith("src/adapters/"),
  );
  if (!touchesSrc) {
    console.log("verify:changesets — no production src/ changes (skipped)");
    process.exit(0);
  }

  const changesetDir = join(root, ".changeset");
  if (!existsSync(changesetDir)) {
    console.error(
      "verify:changesets — .changeset/ directory missing. Run `npx changeset init`.",
    );
    process.exit(1);
  }

  const newChangesets = files.filter(
    (f) =>
      f.startsWith(".changeset/") &&
      f.endsWith(".md") &&
      !f.endsWith("README.md"),
  );

  // Also accept any uncommitted .md files in .changeset/ (local-dev case).
  const localChangesets = readdirSync(changesetDir).filter(
    (f) => f.endsWith(".md") && f !== "README.md",
  );

  if (newChangesets.length === 0 && localChangesets.length === 0) {
    console.error(
      [
        "verify:changesets — production src/ changed but no changeset found.",
        "",
        "  Files changed (src/):",
        ...files
          .filter((f) => f.startsWith("src/"))
          .slice(0, 10)
          .map((f) => `    - ${f}`),
        "",
        "  Fix: run `npm run changeset` and commit the new .changeset/*.md file.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(
    `verify:changesets — ok (${newChangesets.length || localChangesets.length} changeset(s))`,
  );
  process.exit(0);
}

main();
