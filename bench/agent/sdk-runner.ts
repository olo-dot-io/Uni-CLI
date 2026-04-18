/**
 * Claude Agent SDK bench runner — drives real trials against Haiku 4.5.
 *
 * Writes bench/agent/results.json with REAL asr_sem numbers (not null).
 * The quick bench (bench/agent/report.ts) is still the CI-cheap variant;
 * this runner is the ship-gate source of truth.
 *
 * Usage:
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   export ANTHROPIC_BENCH_AUTOAPPROVE=1
 *   npm run bench:agent
 *   npm run bench:gate
 *
 * Cost budget: 5 tasks × 4 ICS buckets × 3 channels × 10 trials = 600 trials
 * Haiku 4.5 expected cost: ~$3-5 total.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  genAllBuckets,
  type BenchPayload,
  type Channel,
} from "./payload-factory.js";
import {
  judgeAsrExec,
  judgeAsrGen,
  judgeAsrSem,
  type Emission,
} from "./sdk-judges.js";
import { aggregate, type TaskDef, type TrialResult } from "./sdk-aggregate.js";

// ── Config ────────────────────────────────────────────────────────────────

const MODEL = "claude-haiku-4-5" as const;
const TRIALS_PER_CELL = parseInt(process.env.UNICLI_BENCH_TRIALS ?? "10", 10);
const CHANNELS: readonly Channel[] = ["shell", "file", "stdin"] as const;
const EST_IN_TOK = 500;
const EST_OUT_TOK = 120;
const HAIKU_IN_USD = 0.25;
const HAIKU_OUT_USD = 1.25;
const MAX_RATE_LIMIT_RETRIES = 3;

export const TASKS: readonly TaskDef[] = [
  {
    site: "hackernews",
    cmd: "top",
    expected: { minResults: 1, keyFields: ["title"] },
  },
  {
    site: "hackernews",
    cmd: "search",
    expected: { minResults: 1, keyFields: ["title"] },
  },
  {
    site: "github",
    cmd: "search",
    expected: { minResults: 1, keyFields: ["name", "full_name", "title"] },
  },
  {
    site: "arxiv",
    cmd: "search",
    expected: { minResults: 1, keyFields: ["title"] },
  },
  {
    site: "bilibili",
    cmd: "popular",
    expected: { minResults: 1, keyFields: ["title"] },
  },
];

// ── Prompt builder ─────────────────────────────────────────────────────────

function buildPrompt(
  task: TaskDef,
  channel: Channel,
  payload: BenchPayload,
  unicliBin: string,
): string {
  const argsJson = JSON.stringify(payload.args);
  const firstKey = task.expected.keyFields[0];
  const base =
    `You are invoking the \`unicli\` CLI. Its binary is at ${unicliBin}. Run it via the Bash tool.\n\n` +
    `Task: retrieve results from ${task.site} ${task.cmd} with these exact arguments (JSON): ${argsJson}\n\n` +
    `You MUST:\n` +
    `1. Emit the command using the ${channel} channel as described below.\n` +
    `2. Report the result as a brief line like: "Found N results. First item title: <title>."\n\n` +
    `Channel protocol:`;
  if (channel === "shell") {
    return (
      base +
      `\n- Construct a single \`unicli --format json ${task.site} ${task.cmd} ...\` invocation with the args as --flags.\n` +
      `- String values MUST be shell-quoted correctly.\n` +
      `- Note: \`--format json\` is a GLOBAL flag and must come BEFORE the site/command.\n` +
      `- Parse the JSON stdout. N = .data length. first title = .data[0].${firstKey}.`
    );
  }
  if (channel === "file") {
    return (
      base +
      `\n- First, write the JSON args to /tmp/unicli-bench-args.json via heredoc:\n` +
      `  cat > /tmp/unicli-bench-args.json <<'JSON'\n  ${argsJson}\n  JSON\n` +
      `- Then: \`unicli --args-file /tmp/unicli-bench-args.json --format json ${task.site} ${task.cmd}\`.\n` +
      `- Parse JSON stdout. N = .data length. first title = .data[0].${firstKey}.`
    );
  }
  const escaped = argsJson.replace(/'/g, "'\\''");
  return (
    base +
    `\n- Pipe the JSON on stdin: \`echo '${escaped}' | unicli --format json ${task.site} ${task.cmd}\`.\n` +
    `- Parse JSON stdout. N = .data length. first title = .data[0].${firstKey}.`
  );
}

// ── Single trial ───────────────────────────────────────────────────────────

interface RunTrialArgs {
  task: TaskDef;
  channel: Channel;
  payload: BenchPayload;
  trialId: number;
  unicliBin: string;
  emissionSink?: string;
}

async function invokeSdk(
  promptText: string,
  emissions: Emission[],
): Promise<{
  finalResult?: string;
  errorMessage?: string;
  cost: number;
  inTok: number;
  outTok: number;
}> {
  let finalResult: string | undefined;
  let errorMessage: string | undefined;
  let cost = 0;
  let inTok = 0;
  let outTok = 0;
  try {
    for await (const msg of query({
      prompt: promptText,
      options: {
        model: MODEL,
        allowedTools: ["Bash"],
        maxTurns: 4,
        canUseTool: async (toolName, input) => {
          emissions.push({ tool: toolName, input });
          return { behavior: "allow", updatedInput: input };
        },
      },
    })) {
      const m = msg as SDKMessage;
      if (m.type === "result") {
        if (m.subtype === "success") {
          finalResult = m.result;
          inTok = m.usage?.input_tokens ?? 0;
          outTok = m.usage?.output_tokens ?? 0;
          cost = m.total_cost_usd ?? 0;
        } else {
          errorMessage = `result.${m.subtype}`;
        }
      }
    }
  } catch (err) {
    errorMessage = (err as Error).message ?? String(err);
  }
  return { finalResult, errorMessage, cost, inTok, outTok };
}

export async function runTrial(args: RunTrialArgs): Promise<TrialResult> {
  const { task, channel, payload, trialId, unicliBin, emissionSink } = args;
  const started = Date.now();
  const emissions: Emission[] = [];
  const sdk = await invokeSdk(
    buildPrompt(task, channel, payload, unicliBin),
    emissions,
  );

  const gen = judgeAsrGen(emissions, channel);
  let execOk = false;
  let execStdout = "";
  if (gen.ok && gen.command) {
    const r = await judgeAsrExec(gen.command);
    execOk = r.ok;
    execStdout = r.stdout;
  }
  const semOk = execOk
    ? judgeAsrSem(sdk.finalResult, execStdout, task.expected)
    : false;

  if (emissionSink) {
    appendFileSync(
      emissionSink,
      JSON.stringify({
        task: { site: task.site, cmd: task.cmd },
        bucket: payload.target,
        channel,
        trial_id: trialId,
        emissions,
        finalResult: sdk.finalResult,
        asr_gen: gen.ok,
        asr_exec: execOk,
        asr_sem: semOk,
        error: sdk.errorMessage,
        stdout_snippet: execStdout.slice(0, 200),
      }) + "\n",
    );
  }

  return {
    task: { site: task.site, cmd: task.cmd },
    ics_bucket: payload.target,
    channel,
    trial_id: trialId,
    asr_gen: gen.ok,
    asr_exec: execOk,
    asr_sem: semOk,
    duration_ms: Date.now() - started,
    cost_usd: sdk.cost,
    input_tokens: sdk.inTok,
    output_tokens: sdk.outTok,
    error: sdk.errorMessage,
  };
}

async function runWithRetry(
  args: RunTrialArgs,
): Promise<{ result: TrialResult; retries: number }> {
  let retries = 0;
  let last: TrialResult | undefined;
  while (retries < MAX_RATE_LIMIT_RETRIES) {
    last = await runTrial(args);
    const rl = /rate[_ ]limit|429|overloaded/i.test(last.error ?? "");
    if (!rl) return { result: last, retries };
    retries++;
    const backoff = Math.min(30_000, 1000 * 2 ** retries);
    process.stderr.write(
      `[bench] rate-limit ${args.task.site}/${args.task.cmd}#${args.channel}#${args.trialId}; backoff ${backoff}ms (${retries}/${MAX_RATE_LIMIT_RETRIES})\n`,
    );
    await new Promise((r) => setTimeout(r, backoff));
  }
  return { result: last!, retries };
}

// ── Pre-flight checks ──────────────────────────────────────────────────────

function estCost(nTrials: number): number {
  return (
    (nTrials * EST_IN_TOK * HAIKU_IN_USD) / 1_000_000 +
    (nTrials * EST_OUT_TOK * HAIKU_OUT_USD) / 1_000_000
  );
}

async function confirmProceed(totalTrials: number): Promise<void> {
  const est = estCost(totalTrials);
  process.stderr.write(
    `[bench] ${totalTrials} trials on ${MODEL}\n` +
      `[bench] estimated cost: $${est.toFixed(2)} — proceed? (set ANTHROPIC_BENCH_AUTOAPPROVE=1 to skip this prompt)\n`,
  );
  if (process.env.ANTHROPIC_BENCH_AUTOAPPROVE === "1") return;
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "[bench] non-TTY: set ANTHROPIC_BENCH_AUTOAPPROVE=1 to run non-interactively\n",
    );
    process.exit(78);
  }
  const ans: string = await new Promise((res) => {
    process.stderr.write("[bench] proceed? (y/N) ");
    process.stdin.once("data", (d) => res(String(d).trim()));
  });
  if (!/^y(es)?$/i.test(ans)) {
    process.stderr.write("[bench] aborted by user\n");
    process.exit(0);
  }
}

function assertEnv(): string {
  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write(
      "\n[bench] ANTHROPIC_API_KEY is not set.\n" +
        "  export ANTHROPIC_API_KEY=sk-ant-...\n" +
        "  (Get a key at https://console.anthropic.com/)\n\n",
    );
    process.exit(77);
  }
  const unicliBin = resolve(process.cwd(), "dist/main.js");
  if (!existsSync(unicliBin)) {
    process.stderr.write(
      `[bench] dist/main.js not found — run \`npm run build\` first\n`,
    );
    process.exit(78);
  }
  return unicliBin;
}

// ── Corpus expansion ───────────────────────────────────────────────────────

interface Cell {
  task: TaskDef;
  payload: BenchPayload;
  channel: Channel;
  trialId: number;
}

function buildCells(): Cell[] {
  const cells: Cell[] = [];
  for (const task of TASKS) {
    for (const payload of genAllBuckets(task.site, task.cmd)) {
      for (const channel of CHANNELS) {
        for (let i = 0; i < TRIALS_PER_CELL; i++) {
          cells.push({ task, payload, channel, trialId: i });
        }
      }
    }
  }
  return cells;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const unicliBin = assertEnv();
  const totalTrials = TASKS.length * 4 * CHANNELS.length * TRIALS_PER_CELL;
  await confirmProceed(totalTrials);

  const cells = buildCells();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const emissionSink = resolve(
    process.cwd(),
    `bench/agent/emissions-${ts}.jsonl`,
  );
  mkdirSync(dirname(emissionSink), { recursive: true });

  const results: TrialResult[] = [];
  const started = Date.now();
  let totalRetries = 0;
  let actualCost = 0;

  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const { result, retries } = await runWithRetry({
      task: c.task,
      channel: c.channel,
      payload: c.payload,
      trialId: c.trialId,
      unicliBin,
      emissionSink,
    });
    results.push(result);
    totalRetries += retries;
    actualCost += result.cost_usd;
    if ((i + 1) % 10 === 0 || i === cells.length - 1) {
      const pct = (((i + 1) / cells.length) * 100).toFixed(1);
      const min = ((Date.now() - started) / 60_000).toFixed(1);
      process.stderr.write(
        `[bench] ${i + 1}/${cells.length} (${pct}%)  elapsed=${min}m  cost=$${actualCost.toFixed(3)}  retries=${totalRetries}\n`,
      );
    }
  }

  writeReport({
    results,
    totalTrials,
    totalRetries,
    actualCost,
    wallMin: (Date.now() - started) / 60_000,
    emissionSink,
  });
}

interface ReportArgs {
  results: TrialResult[];
  totalTrials: number;
  totalRetries: number;
  actualCost: number;
  wallMin: number;
  emissionSink: string;
}

function writeReport(args: ReportArgs): void {
  const { rows, summary } = aggregate(TASKS, args.results);
  const out = {
    schema_version: "bench-v2",
    generated_at: new Date().toISOString(),
    model: MODEL,
    model_version_hash: process.env.ANTHROPIC_MODEL_HASH ?? "",
    tasks: TASKS.length,
    trials_per_cell: TRIALS_PER_CELL,
    channels: CHANNELS.length,
    buckets: 4,
    total_trials: args.results.length,
    expected_trials: args.totalTrials,
    total_cost_usd: Math.round(args.actualCost * 1000) / 1000,
    wall_time_minutes: Math.round(args.wallMin * 1000) / 1000,
    retries: args.totalRetries,
    rows,
    summary,
    emission_log: args.emissionSink,
  };
  const outPath = resolve(process.cwd(), "bench/agent/results.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  process.stderr.write(
    `\n[bench] wrote ${outPath}\n` +
      `[bench] total cost: $${args.actualCost.toFixed(3)} over ${args.wallMin.toFixed(1)} min, ${args.totalRetries} retries\n` +
      `[bench] asr_sem @ICS=8 stdin: ${summary.asr_sem_at_ics8_stdin}\n` +
      `[bench] sed @ICS=8:            ${summary.sed_at_ics8}\n` +
      `[bench] asr_sem @ICS=2 shell:  ${summary.asr_sem_at_ics2_shell}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`[bench] fatal: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
