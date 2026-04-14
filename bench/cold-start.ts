/**
 * cold-start.ts — measure `unicli list` cold-start latency and token cost.
 *
 * Runs the built CLI binary N times, captures wall-clock (p50/p95) and
 * the token count of the rendered response (json format, full catalog).
 * No network traffic — list is a pure read of the manifest.
 *
 * Usage (standalone): npx tsx bench/cold-start.ts
 * Invoked by:         bench/report.ts
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { estimateTokens, percentile } from "./tokens.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const CLI_ENTRY = join(REPO_ROOT, "dist", "main.js");

export interface ColdStartResult {
  target: "unicli list";
  runs: number;
  wall_ms_p50: number;
  wall_ms_p95: number;
  response_tokens: number;
  response_chars: number;
  sites: number;
  commands: number;
}

export function runColdStart(runs: number = 50): ColdStartResult {
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(
      `cold-start bench requires built dist. Run \`npm run build\` first. Expected ${CLI_ENTRY}`,
    );
  }

  const wallMs: number[] = [];
  let lastStdout = "";
  let lastJson: unknown = [];

  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const res = spawnSync(process.execPath, [CLI_ENTRY, "list", "-f", "json"], {
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 15_000,
    });
    const t1 = performance.now();
    if (res.status !== 0) {
      throw new Error(
        `cold-start run ${i} failed with status ${res.status}:\n${res.stderr}`,
      );
    }
    wallMs.push(t1 - t0);
    lastStdout = res.stdout;
  }

  try {
    lastJson = JSON.parse(lastStdout);
  } catch {
    lastJson = [];
  }

  const rowCount = Array.isArray(lastJson) ? lastJson.length : 0;
  const sites = new Set(
    (lastJson as { site?: string }[]).map((r) => r.site).filter(Boolean),
  ).size;

  wallMs.sort((a, b) => a - b);
  const tokenEst = estimateTokens(lastStdout);

  return {
    target: "unicli list",
    runs,
    wall_ms_p50: Math.round(percentile(wallMs, 50)),
    wall_ms_p95: Math.round(percentile(wallMs, 95)),
    response_tokens: tokenEst.tokens,
    response_chars: tokenEst.chars,
    sites,
    commands: rowCount,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runColdStart(Number(process.env.BENCH_RUNS ?? 50));
  console.log(JSON.stringify(result, null, 2));
}
