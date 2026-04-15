/**
 * Vitest globalSetup — ensures build artifacts that the runtime depends on
 * exist before any test runs.
 *
 * Why: src/discovery/search.ts reads dist/manifest-search.json at import time.
 * Without this, tests pass locally (stale dist/ residue) but fail in CI
 * (clean checkout), producing the exact class of environment-asymmetric
 * failures that the main verify script was papering over.
 *
 * Contract: tests must be self-contained. If a test needs a build artifact,
 * it is this hook's job to ensure it, not the human's.
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MANIFEST = join(ROOT, "dist", "manifest-search.json");

export default function setup(): void {
  // Unblock the SSRF guard (assertSafeRequestUrl in src/engine/ssrf.ts)
  // so tests that spin up a loopback HTTP server can still hit 127.0.0.1.
  // Production runs never set this — only the test harness, which owns the
  // localhost it is about to fetch.
  process.env.UNICLI_ALLOW_LOCAL = process.env.UNICLI_ALLOW_LOCAL ?? "1";

  if (existsSync(MANIFEST)) return;

  process.stderr.write(
    "[vitest setup] dist/manifest-search.json missing — running build:manifest\n",
  );

  const result = spawnSync("npm", ["run", "--silent", "build:manifest"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    throw new Error(
      `[vitest setup] build:manifest failed (exit ${result.status}). ` +
        `Tests cannot run without the search manifest.`,
    );
  }
}
