/**
 * @owner       bench::cold-start
 * @does        Measures cold-process root metadata and manifest-list latency plus catalog response size.
 * @needs       built dist/main.js, subprocess spawn, token estimator
 * @feeds       bench/report.ts and docs/BENCHMARK.md generated evidence
 * @breaks      Missing build, timeout, non-zero exit, or invalid list JSON fails the benchmark.
 * @invariants  Every timing is a new Node process; updater network work is disabled; no warm daemon/MCP claim is inferred.
 * @side-effects Spawns three command shapes per configured run count.
 * @perf        Default 150 bounded subprocesses (50 each for version/help/list).
 * @concurrency Sequential to avoid host-load contamination.
 * @test        tests/unit/cold-start-bench.test.ts
 * @stability   stable
 * @since       2026-04-30
 *
 * Usage (standalone): npx tsx bench/cold-start.ts
 * Invoked by:         bench/report.ts
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateTokens, percentile } from "./tokens.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const CLI_ENTRY = join(REPO_ROOT, "dist", "main.js");
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

export interface ColdStartResult {
  target: "unicli root metadata and list";
  runs: number;
  version_wall_ms_p50: number;
  version_wall_ms_p95: number;
  help_wall_ms_p50: number;
  help_wall_ms_p95: number;
  wall_ms_p50: number;
  wall_ms_p95: number;
  response_tokens: number;
  response_chars: number;
  sites: number;
  commands: number;
}

type ListRow = { site?: string };

interface CommandMeasurement {
  wallMs: number[];
  stdout: string;
}

function measureCommand(args: string[], runs: number): CommandMeasurement {
  const wallMs: number[] = [];
  let stdout = "";
  for (let index = 0; index < runs; index += 1) {
    const startedAt = performance.now();
    const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
      encoding: "utf-8",
      env: {
        ...process.env,
        NO_COLOR: "1",
        NO_UPDATE_NOTIFIER: "1",
        UNICLI_DYNAMIC_MACOS: "0",
      },
      timeout: 15_000,
      maxBuffer: MAX_STDOUT_BYTES,
    });
    const completedAt = performance.now();
    if (result.status !== 0) {
      throw new Error(
        `cold-start ${args.join(" ")} run ${index} failed with status ${result.status}:\n${result.stderr}`,
      );
    }
    wallMs.push(completedAt - startedAt);
    stdout = result.stdout;
  }
  wallMs.sort((left, right) => left - right);
  return { wallMs, stdout };
}

function listRowsFromJson(value: unknown): ListRow[] {
  if (Array.isArray(value)) {
    return value as ListRow[];
  }

  if (
    value &&
    typeof value === "object" &&
    "data" in value &&
    Array.isArray((value as { data?: unknown }).data)
  ) {
    return (value as { data: ListRow[] }).data;
  }

  return [];
}

export function runColdStart(runs: number = 50): ColdStartResult {
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error(
      `cold-start runs must be a positive integer, received ${runs}`,
    );
  }
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(
      `cold-start bench requires built dist. Run \`npm run build\` first. Expected ${CLI_ENTRY}`,
    );
  }

  const version = measureCommand(["--version"], runs);
  const help = measureCommand(["--help"], runs);
  const list = measureCommand(["list", "-f", "json"], runs);
  let lastJson: unknown = [];

  try {
    lastJson = JSON.parse(list.stdout);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`cold-start list output was not valid JSON: ${message}`);
  }

  const rows = listRowsFromJson(lastJson);
  const rowCount = rows.length;
  const sites = new Set(rows.map((r) => r.site).filter(Boolean)).size;

  const tokenEst = estimateTokens(list.stdout);

  return {
    target: "unicli root metadata and list",
    runs,
    version_wall_ms_p50: Math.round(percentile(version.wallMs, 50)),
    version_wall_ms_p95: Math.round(percentile(version.wallMs, 95)),
    help_wall_ms_p50: Math.round(percentile(help.wallMs, 50)),
    help_wall_ms_p95: Math.round(percentile(help.wallMs, 95)),
    wall_ms_p50: Math.round(percentile(list.wallMs, 50)),
    wall_ms_p95: Math.round(percentile(list.wallMs, 95)),
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
