/**
 * adapter-call.ts — measure p50/p95 adapter call latency + response size.
 *
 * Two modes:
 *
 *   live    — run the actual adapter through the built CLI; requires
 *             network. Used for local `npm run bench` on a dev machine.
 *
 *   fixture — read the captured response body from `bench/fixtures/`
 *             and measure only the in-process tokenisation + render.
 *             Deterministic, network-free, suitable for CI. This is
 *             the default when BENCH_FIXTURES_ONLY=1 or --mode=fixture
 *             is passed.
 *
 * The headline p50/p95 in docs/BENCHMARK.md are fixture-based so CI
 * produces byte-identical runs. The "live" numbers are a sanity check
 * printed as a secondary column.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateTokens, percentile } from "./tokens.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const CLI_ENTRY = join(REPO_ROOT, "dist", "main.js");
const FIXTURES_DIR = join(HERE, "fixtures");

export interface AdapterCall {
  label: string;
  site: string;
  command: string;
  args: string[];
  fixture: string; // fixture file name in bench/fixtures/
}

export interface AdapterCallResult {
  label: string;
  site: string;
  command: string;
  invocation: string;
  invocation_tokens: number;
  mode: "fixture" | "live" | "fixture-fallback";
  runs: number;
  wall_ms_p50: number;
  wall_ms_p95: number;
  response_chars: number;
  response_tokens: number;
  response_tokens_p50: number;
  response_tokens_p95: number;
  notes?: string;
}

export const CALL_SUITE: AdapterCall[] = [
  {
    label: "news",
    site: "hackernews",
    command: "top",
    args: ["--limit", "5"],
    fixture: "hackernews-top.json",
  },
  {
    label: "social",
    site: "reddit",
    command: "hot",
    args: ["--limit", "5"],
    fixture: "reddit-hot.json",
  },
  {
    label: "social-cn",
    site: "36kr",
    command: "hot",
    args: ["--limit", "5"],
    fixture: "36kr-hot.json",
  },
  {
    label: "dev",
    site: "github-trending",
    command: "daily",
    args: ["--limit", "5"],
    fixture: "github-trending-daily.json",
  },
];

function invocationString(call: AdapterCall): string {
  return `unicli ${call.site} ${call.command} ${call.args.join(" ")}`.trim();
}

export function normalizeFixtureBody(call: AdapterCall, body: string): string {
  const parsed = JSON.parse(body) as unknown;

  if (
    parsed &&
    typeof parsed === "object" &&
    "ok" in parsed &&
    "schema_version" in parsed &&
    "data" in parsed
  ) {
    return body;
  }

  const count = Array.isArray(parsed) ? parsed.length : undefined;
  return `${JSON.stringify(
    {
      ok: true,
      schema_version: "2",
      command: `${call.site}.${call.command}`,
      meta: {
        duration_ms: 0,
        ...(count !== undefined ? { count } : {}),
      },
      data: parsed,
      error: null,
    },
    null,
    2,
  )}\n`;
}

function liveRun(
  call: AdapterCall,
  runs: number,
): { wallMs: number[]; lastStdout: string } | null {
  if (!existsSync(CLI_ENTRY)) return null;
  const wallMs: number[] = [];
  let lastStdout = "";
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const res = spawnSync(
      process.execPath,
      [CLI_ENTRY, call.site, call.command, "-f", "json", ...call.args],
      {
        encoding: "utf-8",
        env: { ...process.env, NO_COLOR: "1" },
        timeout: 20_000,
      },
    );
    const t1 = performance.now();
    if (res.status !== 0) {
      return null; // surface fallback to caller
    }
    wallMs.push(t1 - t0);
    lastStdout = res.stdout;
  }
  return { wallMs, lastStdout };
}

function fixtureRun(call: AdapterCall, runs: number): AdapterCallResult {
  const fixturePath = join(FIXTURES_DIR, call.fixture);
  const body = normalizeFixtureBody(call, readFileSync(fixturePath, "utf-8"));
  const wallMs: number[] = [];
  const tokenSamples: number[] = [];

  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const tokenEst = estimateTokens(body);
    const t1 = performance.now();
    wallMs.push(t1 - t0);
    tokenSamples.push(tokenEst.tokens);
  }

  wallMs.sort((a, b) => a - b);
  tokenSamples.sort((a, b) => a - b);

  const invocation = invocationString(call);
  const invTokens = estimateTokens(invocation).tokens;
  const bodyEst = estimateTokens(body);

  return {
    label: call.label,
    site: call.site,
    command: call.command,
    invocation,
    invocation_tokens: invTokens,
    mode: "fixture",
    runs,
    wall_ms_p50: Math.round(percentile(wallMs, 50) * 1000) / 1000,
    wall_ms_p95: Math.round(percentile(wallMs, 95) * 1000) / 1000,
    response_chars: bodyEst.chars,
    response_tokens: bodyEst.tokens,
    response_tokens_p50: percentile(tokenSamples, 50),
    response_tokens_p95: percentile(tokenSamples, 95),
  };
}

export function runAdapterCall(
  call: AdapterCall,
  runs: number,
  mode: "live" | "fixture",
): AdapterCallResult {
  if (mode === "fixture") {
    return fixtureRun(call, runs);
  }

  const live = liveRun(call, runs);
  if (live === null) {
    const fallback = fixtureRun(call, runs);
    fallback.mode = "fixture-fallback";
    fallback.notes = "live call failed; falling back to captured fixture";
    return fallback;
  }

  const invocation = invocationString(call);
  const invTokens = estimateTokens(invocation).tokens;
  live.wallMs.sort((a, b) => a - b);

  const tokenEst = estimateTokens(live.lastStdout);

  return {
    label: call.label,
    site: call.site,
    command: call.command,
    invocation,
    invocation_tokens: invTokens,
    mode: "live",
    runs,
    wall_ms_p50: Math.round(percentile(live.wallMs, 50)),
    wall_ms_p95: Math.round(percentile(live.wallMs, 95)),
    response_chars: tokenEst.chars,
    response_tokens: tokenEst.tokens,
    response_tokens_p50: tokenEst.tokens, // single-body sample
    response_tokens_p95: tokenEst.tokens,
  };
}

export function runSuite(
  runs: number,
  mode: "live" | "fixture",
): AdapterCallResult[] {
  return CALL_SUITE.map((call) => runAdapterCall(call, runs, mode));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const runs = Number(process.env.BENCH_RUNS ?? 50);
  const mode = process.env.BENCH_FIXTURES_ONLY === "1" ? "fixture" : "live";
  const results = runSuite(runs, mode);
  console.log(JSON.stringify({ mode, runs, results }, null, 2));
}
