/**
 * validate-agents-size — Fail the build when AGENTS.md exceeds its budget.
 *
 * AGENTS.md is the agent discovery surface. It is consumed at every agent
 * cold start (Claude Code, Codex, OpenCode, Cursor), so every byte is a
 * per-request tax. The project keeps it ≤ 8192 bytes — roughly 2K
 * tokens — which fits comfortably in a system-prompt preamble.
 *
 * The `build-agents.ts` generator already truncates long category lists.
 * This script is the safety net: if future edits inflate the file past
 * the budget, `npm run verify` fails before the change reaches main.
 *
 * Exit:
 *   0  — AGENTS.md is within budget
 *   1  — AGENTS.md is missing or over budget
 */

import { statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const AGENTS_PATH = join(ROOT, "AGENTS.md");

const MAX_BYTES = 8192;

function main(): void {
  if (!existsSync(AGENTS_PATH)) {
    console.error("validate-agents-size: AGENTS.md is missing.");
    process.exit(1);
  }
  const { size } = statSync(AGENTS_PATH);
  if (size > MAX_BYTES) {
    console.error(
      `validate-agents-size: FAIL — AGENTS.md is ${size} bytes, budget is ${MAX_BYTES} bytes (${size - MAX_BYTES} over).`,
    );
    console.error(
      "  Trim static content, or lower MAX_SITES_PER_CATEGORY in scripts/build-agents.ts.",
    );
    process.exit(1);
  }
  const pct = ((size / MAX_BYTES) * 100).toFixed(1);
  console.log(
    `validate-agents-size: PASS — AGENTS.md is ${size} bytes (${pct}% of ${MAX_BYTES}-byte budget).`,
  );
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFile) {
  main();
}
