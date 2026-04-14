/**
 * mcp-catalog.ts — compare the cold-start cost of an MCP tool catalog
 * vs. a single Uni-CLI invocation.
 *
 * External reference: GitHub's official MCP server registers 93 tools
 * at boot for ~55,000 tokens of system-prompt overhead. This bench
 * measures the equivalent Uni-CLI cost for one call:
 *
 *   cost(unicli) = invocation_tokens + response_tokens (p50)
 *
 * and reports the reduction factor vs the 55K baseline. The claim in
 * docs/THEORY.md §3.3 and docs/BENCHMARK.md §Target is "beat GitHub
 * MCP 55K cold-start by 30x on p50 response for bread-and-butter
 * commands." This script tells us whether we cleared that bar.
 *
 * We use only fixture data here so the result is reproducible in CI.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateTokens } from "./tokens.js";
import { CALL_SUITE } from "./adapter-call.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "fixtures");
const GITHUB_MCP_BASELINE_TOKENS = 55_000;

export interface McpComparisonRow {
  label: string;
  command: string;
  invocation_tokens: number;
  response_tokens: number;
  total_tokens: number;
  reduction_factor_vs_55k: number; // higher is better
}

export interface McpComparisonResult {
  baseline: "GitHub MCP 55K cold-start";
  baseline_tokens: number;
  rows: McpComparisonRow[];
  target_reduction: number;
  best_reduction: number;
  median_reduction: number;
  claim_holds: boolean;
}

export function runMcpComparison(): McpComparisonResult {
  const rows: McpComparisonRow[] = [];

  for (const call of CALL_SUITE) {
    const invocation =
      `unicli ${call.site} ${call.command} ${call.args.join(" ")}`.trim();
    const body = readFileSync(join(FIXTURES_DIR, call.fixture), "utf-8");
    const invTokens = estimateTokens(invocation).tokens;
    const respTokens = estimateTokens(body).tokens;
    const total = invTokens + respTokens;
    rows.push({
      label: call.label,
      command: invocation,
      invocation_tokens: invTokens,
      response_tokens: respTokens,
      total_tokens: total,
      reduction_factor_vs_55k:
        Math.round((GITHUB_MCP_BASELINE_TOKENS / total) * 10) / 10,
    });
  }

  const reductions = rows
    .map((r) => r.reduction_factor_vs_55k)
    .sort((a, b) => a - b);
  const median = reductions[Math.floor(reductions.length / 2)] ?? 0;
  const best = reductions[reductions.length - 1] ?? 0;
  const TARGET = 30;

  return {
    baseline: "GitHub MCP 55K cold-start",
    baseline_tokens: GITHUB_MCP_BASELINE_TOKENS,
    rows,
    target_reduction: TARGET,
    best_reduction: best,
    median_reduction: median,
    claim_holds: median >= TARGET,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runMcpComparison();
  console.log(JSON.stringify(result, null, 2));
}
