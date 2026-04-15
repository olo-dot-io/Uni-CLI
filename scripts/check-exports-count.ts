/**
 * CI gate — guards `package.json` `exports` subpath count.
 *
 * Rationale: plugin authors depend on stable subpath imports. Accidentally
 * shrinking the surface breaks downstream packages. Floor of 20 leaves
 * room for a few legitimate drops while flagging regressions.
 *
 * Exit 0 when count >= THRESHOLD. Exit 1 otherwise.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const THRESHOLD = 20;

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(here, "..", "package.json");

if (!existsSync(pkgPath)) {
  console.error(`[exports-count] package.json not found at ${pkgPath}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
  exports?: Record<string, unknown>;
};

const exportsMap = pkg.exports ?? {};
const subpaths = Object.keys(exportsMap);
const count = subpaths.length;

if (count < THRESHOLD) {
  console.error(
    `[exports-count] FAIL: package.json exports has ${count} subpaths, ` +
      `below threshold of ${THRESHOLD}.\n` +
      `Subpaths: ${subpaths.join(", ")}\n` +
      `Plugin authors rely on these — restore missing exports before landing.`,
  );
  process.exit(1);
}

console.log(`[exports-count] OK: ${count} subpaths (threshold ${THRESHOLD}).`);
process.exit(0);
