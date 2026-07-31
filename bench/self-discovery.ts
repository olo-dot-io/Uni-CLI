/**
 * self-discovery.ts — measure agent self-discovery and dry-run self-call flow.
 *
 * Compares the legacy three-process flow with the one-shot intent planner:
 *   legacy:   intent -> search -> describe -> dry-run plan
 *   one-shot: intent -> do (rank + schema + invocation in one envelope)
 *
 * It is network-free. The dry-run stage validates routing, schema discovery,
 * argument binding, and command planning without calling upstream services.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const CLI_ENTRY = join(REPO_ROOT, "dist", "main.js");

interface DiscoveryCase {
  id: string;
  intent: string;
  expected: {
    site: string;
    command: string;
  };
  args: string[];
  topK: number;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  wall_ms: number;
}

const CASES: DiscoveryCase[] = [
  {
    id: "news-top",
    intent: "hackernews top stories",
    expected: { site: "hackernews", command: "top" },
    args: ["--limit", "2"],
    topK: 1,
  },
  {
    id: "dev-trending",
    intent: "github-trending daily",
    expected: { site: "github-trending", command: "daily" },
    args: ["--limit", "2"],
    topK: 1,
  },
  {
    id: "finance-price",
    intent: "binance bitcoin price",
    expected: { site: "binance", command: "price" },
    args: ["BTCUSDT"],
    topK: 1,
  },
  {
    id: "finance-depth",
    intent: "binance order book depth",
    expected: { site: "binance", command: "depth" },
    args: ["BTCUSDT", "--limit", "5"],
    topK: 1,
  },
  {
    id: "finance-cn-trades",
    intent: "币安 最新成交",
    expected: { site: "binance", command: "trades" },
    args: ["BTCUSDT", "--limit", "5"],
    topK: 3,
  },
  {
    id: "social-hot",
    intent: "reddit hot posts",
    expected: { site: "reddit", command: "hot" },
    args: ["--limit", "2"],
    topK: 1,
  },
  {
    id: "news-cn-hot",
    intent: "36kr hot news",
    expected: { site: "36kr", command: "hot" },
    args: ["--limit", "2"],
    topK: 3,
  },
];

function runCli(args: string[]): RunResult {
  const start = performance.now();
  const res = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 15_000,
  });
  const end = performance.now();
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    wall_ms: Math.round(end - start),
  };
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function commandText(site: string, command: string): string {
  return `${site} ${command}`;
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((pct / 100) * (sorted.length - 1));
  return sorted[idx] ?? 0;
}

function outputBytes(run: RunResult): number {
  return Buffer.byteLength(run.stdout) + Buffer.byteLength(run.stderr);
}

export function runSelfDiscoverySuite(): Record<string, unknown> {
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(
      `self-discovery bench requires built dist. Run \`npm run build\` first. Expected ${CLI_ENTRY}`,
    );
  }

  const results = CASES.map((testCase) => {
    const expectedText = commandText(
      testCase.expected.site,
      testCase.expected.command,
    );
    const searchRun = runCli([
      "-f",
      "json",
      "search",
      testCase.intent,
      "--limit",
      "5",
    ]);
    const searchEnv = parseJson<{
      data?: Array<{ command: string; score?: number }>;
    }>(searchRun.stdout);
    const candidates = searchEnv?.data ?? [];
    const rank = candidates.findIndex((row) => row.command === expectedText);

    const describeRun = runCli([
      "-f",
      "json",
      "describe",
      testCase.expected.site,
      testCase.expected.command,
    ]);
    const describeWire = parseJson<{
      data?: {
        args_schema?: {
          required?: string[];
          properties?: Record<string, unknown>;
        };
      };
      args_schema?: {
        required?: string[];
        properties?: Record<string, unknown>;
      };
    }>(describeRun.stdout);
    const describePayload = describeWire?.data ?? describeWire;
    const describeOk =
      describeRun.status === 0 &&
      Boolean(describePayload?.args_schema?.properties);

    const dryRun = runCli([
      "--dry-run",
      testCase.expected.site,
      testCase.expected.command,
      ...testCase.args,
    ]);
    const plan = parseJson<{
      command?: string;
      args?: Record<string, unknown>;
    }>(dryRun.stdout);
    const dryRunOk =
      dryRun.status === 0 &&
      plan?.command ===
        `${testCase.expected.site}.${testCase.expected.command}` &&
      Boolean(plan.args);

    const oneShotRun = runCli([
      "-f",
      "json",
      "do",
      testCase.intent,
      "--top",
      String(Math.max(1, testCase.topK)),
    ]);
    const oneShotEnv = parseJson<{
      data?: {
        match?: { site?: string; command?: string; invocation?: string };
        candidates?: Array<{
          site?: string;
          command?: string;
          invocation?: string;
          args_schema?: { properties?: Record<string, unknown> };
        }>;
      };
    }>(oneShotRun.stdout);
    const oneShotCandidates = oneShotEnv?.data?.candidates ?? [];
    const oneShotRank = oneShotCandidates.findIndex(
      (candidate) =>
        candidate.site === testCase.expected.site &&
        candidate.command === testCase.expected.command,
    );
    const oneShotExpected =
      oneShotRank >= 0 ? oneShotCandidates[oneShotRank] : undefined;
    const oneShotOk =
      oneShotRun.status === 0 &&
      oneShotRank >= 0 &&
      oneShotRank < testCase.topK &&
      Boolean(oneShotExpected?.args_schema?.properties) &&
      typeof oneShotExpected?.invocation === "string" &&
      typeof oneShotEnv?.data?.match?.invocation === "string";

    const hit = rank >= 0 && rank < testCase.topK;
    const legacyBytes =
      outputBytes(searchRun) + outputBytes(describeRun) + outputBytes(dryRun);
    return {
      id: testCase.id,
      intent: testCase.intent,
      expected: expectedText,
      topK: testCase.topK,
      rank: rank >= 0 ? rank + 1 : null,
      top1: candidates[0]?.command ?? null,
      hit,
      describe_ok: describeOk,
      dry_run_ok: dryRunOk,
      one_shot_ok: oneShotOk,
      calls: { legacy: 3, one_shot: 1 },
      output_bytes: {
        legacy: legacyBytes,
        one_shot: outputBytes(oneShotRun),
      },
      wall_ms: {
        search: searchRun.wall_ms,
        describe: describeRun.wall_ms,
        dry_run: dryRun.wall_ms,
        total: searchRun.wall_ms + describeRun.wall_ms + dryRun.wall_ms,
        one_shot: oneShotRun.wall_ms,
      },
    };
  });

  const totals = results.map((result) => result.wall_ms.total);
  const search = results.map((result) => result.wall_ms.search);
  const describe = results.map((result) => result.wall_ms.describe);
  const dryRun = results.map((result) => result.wall_ms.dry_run);
  const oneShot = results.map((result) => result.wall_ms.one_shot);
  const legacyBytes = results.map((result) => result.output_bytes.legacy);
  const oneShotBytes = results.map((result) => result.output_bytes.one_shot);
  const passed = results.filter(
    (result) =>
      result.hit &&
      result.describe_ok &&
      result.dry_run_ok &&
      result.one_shot_ok,
  ).length;

  return {
    generated_at: new Date().toISOString(),
    cases: results.length,
    passed,
    pass_rate: passed / results.length,
    top1_accuracy:
      results.filter((result) => result.rank === 1).length / results.length,
    topK_accuracy:
      results.filter((result) => result.hit).length / results.length,
    calls_per_case: { legacy: 3, one_shot: 1 },
    output_bytes: {
      legacy_p50: percentile(legacyBytes, 50),
      one_shot_p50: percentile(oneShotBytes, 50),
      reduction_ratio:
        1 - percentile(oneShotBytes, 50) / percentile(legacyBytes, 50),
    },
    latency_ms: {
      search_p50: percentile(search, 50),
      describe_p50: percentile(describe, 50),
      dry_run_p50: percentile(dryRun, 50),
      total_p50: percentile(totals, 50),
      total_p95: percentile(totals, 95),
      one_shot_p50: percentile(oneShot, 50),
      one_shot_p95: percentile(oneShot, 95),
      reduction_ratio: 1 - percentile(oneShot, 50) / percentile(totals, 50),
    },
    results,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(runSelfDiscoverySuite(), null, 2));
}
