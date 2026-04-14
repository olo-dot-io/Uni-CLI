/**
 * report.ts — top-level bench runner.
 *
 * Runs cold-start, adapter-call, and mcp-catalog benches, writes
 * `bench/results.json`, and injects a markdown table into
 * `docs/BENCHMARK.md` between the `<!-- BENCH:begin -->` and
 * `<!-- BENCH:end -->` markers.
 *
 * Usage:   npm run bench
 * Env:
 *   BENCH_RUNS=50              (default 50 iterations per case)
 *   BENCH_FIXTURES_ONLY=1      (skip live network for adapter-call; CI-safe)
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runColdStart } from "./cold-start.js";
import { runSuite, type AdapterCallResult } from "./adapter-call.js";
import { runMcpComparison, type McpComparisonResult } from "./mcp-catalog.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const RESULTS_PATH = join(HERE, "results.json");
const BENCHMARK_MD = join(REPO_ROOT, "docs", "BENCHMARK.md");

const BEGIN_MARKER = "<!-- BENCH:begin -->";
const END_MARKER = "<!-- BENCH:end -->";

interface Report {
  generated_at: string;
  node_version: string;
  platform: string;
  runs: number;
  mode: "live" | "fixture";
  cold_start: ReturnType<typeof runColdStart>;
  adapter_calls: AdapterCallResult[];
  mcp_comparison: McpComparisonResult;
}

function renderMarkdown(report: Report): string {
  const lines: string[] = [];
  lines.push(BEGIN_MARKER);
  lines.push("");
  lines.push(
    `> Generated ${report.generated_at} on Node ${report.node_version} / ${report.platform}.`,
  );
  lines.push(
    `> Mode: **${report.mode}** (${report.runs} iterations per case).`,
  );
  lines.push(
    `> Reproduce with \`npm run bench\` (local live mode) or \`BENCH_FIXTURES_ONLY=1 npm run bench\` (CI-deterministic fixture mode).`,
  );
  lines.push("");
  lines.push("### Cold start: `unicli list`");
  lines.push("");
  lines.push("| metric | value |");
  lines.push("| ------ | ----- |");
  lines.push(`| wall p50 | ${report.cold_start.wall_ms_p50} ms |`);
  lines.push(`| wall p95 | ${report.cold_start.wall_ms_p95} ms |`);
  lines.push(`| response tokens | ${report.cold_start.response_tokens} |`);
  lines.push(`| response chars | ${report.cold_start.response_chars} |`);
  lines.push(`| sites listed | ${report.cold_start.sites} |`);
  lines.push(`| commands listed | ${report.cold_start.commands} |`);
  lines.push("");
  lines.push("### Adapter call: p50/p95 response tokens");
  lines.push("");
  lines.push(
    "| category | command | invocation tokens | response p50 tokens | response p95 tokens | wall p50 ms | wall p95 ms | mode |",
  );
  lines.push(
    "| -------- | ------- | ----------------: | ------------------: | ------------------: | ----------: | ----------: | ---- |",
  );
  for (const r of report.adapter_calls) {
    lines.push(
      `| ${r.label} | \`${r.invocation}\` | ${r.invocation_tokens} | ${r.response_tokens_p50} | ${r.response_tokens_p95} | ${r.wall_ms_p50} | ${r.wall_ms_p95} | ${r.mode} |`,
    );
  }
  lines.push("");
  lines.push("### MCP catalog comparison");
  lines.push("");
  lines.push(
    `Baseline: **${report.mcp_comparison.baseline_tokens.toLocaleString()}-token** GitHub MCP cold-start. Target reduction vs. baseline: **${report.mcp_comparison.target_reduction}x**.`,
  );
  lines.push("");
  lines.push("| category | total tokens | reduction factor vs. 55K |");
  lines.push("| -------- | -----------: | -----------------------: |");
  for (const r of report.mcp_comparison.rows) {
    lines.push(
      `| ${r.label} | ${r.total_tokens} | **${r.reduction_factor_vs_55k}x** |`,
    );
  }
  lines.push("");
  lines.push(
    `Median reduction across the suite: **${report.mcp_comparison.median_reduction}x**. Best: **${report.mcp_comparison.best_reduction}x**.`,
  );
  lines.push(
    `Claim "beat GitHub MCP 55K cold-start by 30x on p50" holds: **${report.mcp_comparison.claim_holds ? "YES" : "NO"}**.`,
  );
  if (!report.mcp_comparison.claim_holds) {
    lines.push("");
    lines.push(
      `> Honesty note: median reduction is ${report.mcp_comparison.median_reduction}x, below the 30x target. The claim in THEORY.md §3.3 and previous BENCHMARK.md drafts is not supported by the current response sizes at \`--limit 5\`. We report the measured number and keep the target as aspirational.`,
    );
  }
  lines.push("");
  lines.push(END_MARKER);
  return lines.join("\n");
}

function patchBenchmarkMd(markdown: string): void {
  if (!existsSync(BENCHMARK_MD)) {
    throw new Error(`BENCHMARK.md missing at ${BENCHMARK_MD}`);
  }
  const source = readFileSync(BENCHMARK_MD, "utf-8");
  const beginIdx = source.indexOf(BEGIN_MARKER);
  const endIdx = source.indexOf(END_MARKER);
  if (beginIdx === -1 || endIdx === -1) {
    throw new Error(
      `BENCHMARK.md missing ${BEGIN_MARKER} / ${END_MARKER} markers`,
    );
  }
  const before = source.slice(0, beginIdx);
  const after = source.slice(endIdx + END_MARKER.length);
  const next = `${before}${markdown}${after}`;
  writeFileSync(BENCHMARK_MD, next);
}

async function main(): Promise<void> {
  const runs = Number(process.env.BENCH_RUNS ?? 50);
  const mode: "live" | "fixture" =
    process.env.BENCH_FIXTURES_ONLY === "1" ? "fixture" : "live";

  console.log(`[bench] mode=${mode} runs=${runs}`);
  console.log(`[bench] cold-start...`);
  const cold = runColdStart(runs);
  console.log(
    `[bench]   wall p50=${cold.wall_ms_p50}ms p95=${cold.wall_ms_p95}ms response=${cold.response_tokens} tokens`,
  );

  console.log(`[bench] adapter-call (${mode})...`);
  const adapterCalls = runSuite(runs, mode);
  for (const r of adapterCalls) {
    console.log(
      `[bench]   ${r.label.padEnd(10)} ${r.command.padEnd(10)} p50=${r.response_tokens_p50}tok p95=${r.response_tokens_p95}tok wall-p50=${r.wall_ms_p50}ms mode=${r.mode}`,
    );
  }

  console.log(`[bench] mcp-catalog...`);
  const mcp = runMcpComparison();
  console.log(
    `[bench]   median reduction=${mcp.median_reduction}x best=${mcp.best_reduction}x target=${mcp.target_reduction}x claim_holds=${mcp.claim_holds}`,
  );

  const report: Report = {
    generated_at: new Date().toISOString(),
    node_version: process.version,
    platform: `${process.platform}-${process.arch}`,
    runs,
    mode,
    cold_start: cold,
    adapter_calls: adapterCalls,
    mcp_comparison: mcp,
  };

  writeFileSync(RESULTS_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[bench] wrote ${RESULTS_PATH}`);

  const md = renderMarkdown(report);
  patchBenchmarkMd(md);
  console.log(`[bench] patched ${BENCHMARK_MD} between BENCH markers`);
}

main().catch((err) => {
  console.error(`[bench] error:`, err);
  process.exit(1);
});
