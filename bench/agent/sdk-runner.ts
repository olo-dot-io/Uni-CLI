/**
 * Multi-model bench runner — drives TC0 trials via the Vercel AI SDK
 * against any OpenAI-compatible endpoint (OpenRouter by default).
 *
 * Writes bench/agent/results.json with real per-model + overall asr_sem
 * numbers. Gate source of truth for v0.213.3 Gagarin TC0 Patch R2.
 *
 * Usage:
 *   export BENCH_API_KEY=sk-or-...              # required (OpenRouter key)
 *   export BENCH_AUTOAPPROVE=1                  # optional, skip confirm
 *   export BENCH_BASE_URL=https://openrouter.ai/api/v1  # optional
 *   export BENCH_MODELS=deepseek/deepseek-chat,anthropic/claude-haiku-4-5,openai/gpt-5-mini
 *   export BENCH_TRIALS_PER_CELL=10
 *   npm run bench:agent
 *   npm run bench:gate
 *
 * Corpus: 5 tasks × 4 ICS buckets × 3 channels × N trials × M models.
 * Default 5 × 4 × 3 × 10 × 3 = 1800 trials across 3 models.
 * Expected cost on OpenRouter: < $1.00 total for the default config.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, stepCountIs, tool } from "ai";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

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
import { type TaskDef, type TrialResult } from "./sdk-aggregate.js";
import {
  DEFAULT_MODELS,
  estimateCostUsd,
  PRICING,
  PRICING_FALLBACK,
} from "./pricing.js";
import { buildReport, type ModelRun } from "./sdk-report.js";

// ── Config ────────────────────────────────────────────────────────────────

const TRIALS_PER_CELL = parseInt(
  process.env.BENCH_TRIALS_PER_CELL ?? process.env.UNICLI_BENCH_TRIALS ?? "10",
  10,
);
const CHANNELS: readonly Channel[] = ["shell", "file", "stdin"] as const;
const MAX_RATE_LIMIT_RETRIES = 3;
const PROVIDER_NAME = "openrouter";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const EST_IN_TOK = 500;
const EST_OUT_TOK = 120;

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
    `You are invoking the \`unicli\` CLI. Its binary is at ${unicliBin}. Run it via the bash tool.\n\n` +
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

// ── Shell execution helper (used by the bash tool) ────────────────────────

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function spawnAndCapture(command: string): Promise<SpawnResult> {
  return new Promise((resolvePromise) => {
    const child = spawn("sh", ["-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 30_000);
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, exitCode: code ?? -1 });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({
        stdout,
        stderr: stderr + String(err?.message ?? err),
        exitCode: -1,
      });
    });
  });
}

// ── Provider wiring ───────────────────────────────────────────────────────

interface ProviderCtx {
  baseURL: string;
  apiKey: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chat: (modelId: string) => any;
}

function buildProvider(): ProviderCtx {
  const apiKey = process.env.BENCH_API_KEY ?? "";
  const baseURL = process.env.BENCH_BASE_URL ?? DEFAULT_BASE_URL;
  const provider = createOpenAICompatible({
    name: PROVIDER_NAME,
    apiKey,
    baseURL,
  });
  return {
    baseURL,
    apiKey,
    chat: (modelId: string) => provider.chatModel(modelId),
  };
}

// ── Single trial ───────────────────────────────────────────────────────────

interface RunTrialArgs {
  task: TaskDef;
  channel: Channel;
  payload: BenchPayload;
  trialId: number;
  unicliBin: string;
  modelId: string;
  provider: ProviderCtx;
  emissionSink?: string;
}

interface SdkInvokeOut {
  finalResult?: string;
  errorMessage?: string;
  inTok: number;
  outTok: number;
}

async function invokeSdk(
  promptText: string,
  emissions: Emission[],
  modelId: string,
  provider: ProviderCtx,
): Promise<SdkInvokeOut> {
  try {
    const { text, usage } = await generateText({
      model: provider.chat(modelId),
      system:
        "You are an agent using unicli via Bash. Call the bash tool to execute commands, then return a brief human-readable summary of the first result.",
      prompt: promptText,
      tools: {
        bash: tool({
          description: "Execute a shell command and capture stdout/stderr.",
          inputSchema: z.object({
            command: z.string().describe("The shell command to execute."),
          }),
          execute: async ({ command }: { command: string }) => {
            emissions.push({ tool: "Bash", input: { command } });
            const r = await spawnAndCapture(command);
            return {
              stdout: r.stdout.slice(0, 8000),
              stderr: r.stderr.slice(0, 2000),
              exit_code: r.exitCode,
            };
          },
        }),
      },
      stopWhen: stepCountIs(4),
      temperature: 0,
    });
    return {
      finalResult: text,
      inTok: Number(usage?.inputTokens ?? 0) || 0,
      outTok: Number(usage?.outputTokens ?? 0) || 0,
    };
  } catch (err) {
    return {
      errorMessage: (err as Error).message ?? String(err),
      inTok: 0,
      outTok: 0,
    };
  }
}

function computeTrialCost(
  modelId: string,
  inTok: number,
  outTok: number,
): number {
  const price = PRICING[modelId] ?? PRICING_FALLBACK;
  return (inTok * price.in) / 1_000_000 + (outTok * price.out) / 1_000_000;
}

export async function runTrial(args: RunTrialArgs): Promise<TrialResult> {
  const started = Date.now();
  const emissions: Emission[] = [];
  const sdk = await invokeSdk(
    buildPrompt(args.task, args.channel, args.payload, args.unicliBin),
    emissions,
    args.modelId,
    args.provider,
  );
  const gen = judgeAsrGen(emissions, args.channel);
  let execOk = false;
  let execStdout = "";
  if (gen.ok && gen.command) {
    const r = await judgeAsrExec(gen.command);
    execOk = r.ok;
    execStdout = r.stdout;
  }
  const semOk = execOk
    ? judgeAsrSem(sdk.finalResult, execStdout, args.task.expected)
    : false;
  const costUsd = computeTrialCost(args.modelId, sdk.inTok, sdk.outTok);
  if (args.emissionSink) {
    appendFileSync(
      args.emissionSink,
      JSON.stringify({
        model: args.modelId,
        task: { site: args.task.site, cmd: args.task.cmd },
        bucket: args.payload.target,
        channel: args.channel,
        trial_id: args.trialId,
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
    task: { site: args.task.site, cmd: args.task.cmd },
    ics_bucket: args.payload.target,
    channel: args.channel,
    trial_id: args.trialId,
    asr_gen: gen.ok,
    asr_exec: execOk,
    asr_sem: semOk,
    duration_ms: Date.now() - started,
    cost_usd: costUsd,
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
    const rl = /rate[_ ]limit|429|overloaded|too many requests/i.test(
      last.error ?? "",
    );
    if (!rl) return { result: last, retries };
    retries++;
    const backoff = Math.min(30_000, 1000 * 2 ** retries);
    process.stderr.write(
      `[bench] rate-limit ${args.modelId} ${args.task.site}/${args.task.cmd}#${args.channel}#${args.trialId}; backoff ${backoff}ms (${retries}/${MAX_RATE_LIMIT_RETRIES})\n`,
    );
    await new Promise((r) => setTimeout(r, backoff));
  }
  return { result: last!, retries };
}

// ── Pre-flight checks ──────────────────────────────────────────────────────

function parseModels(): string[] {
  const raw = process.env.BENCH_MODELS ?? DEFAULT_MODELS.join(",");
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function perModelTrials(): number {
  return TASKS.length * 4 * CHANNELS.length * TRIALS_PER_CELL;
}

function printEstimate(models: string[]): { total: number } {
  const perModel = perModelTrials();
  process.stderr.write(
    `[bench] estimated cost breakdown (per model, ${perModel} trials each):\n`,
  );
  let total = 0;
  for (const m of models) {
    const cost = estimateCostUsd(m, perModel, EST_IN_TOK, EST_OUT_TOK);
    total += cost;
    const pricing = PRICING[m] ?? PRICING_FALLBACK;
    const note = PRICING[m] ? "" : " (fallback pricing)";
    process.stderr.write(
      `[bench]   ${m.padEnd(40)} $${cost.toFixed(3)}  in=$${pricing.in}/M out=$${pricing.out}/M${note}\n`,
    );
  }
  process.stderr.write(
    `[bench] estimated total cost: $${total.toFixed(2)} across ${models.length} models (${perModel} trials per model, ${perModel * models.length} trials total)\n`,
  );
  return { total };
}

async function confirmProceed(models: string[]): Promise<void> {
  printEstimate(models);
  if (
    process.env.BENCH_AUTOAPPROVE === "1" ||
    process.env.ANTHROPIC_BENCH_AUTOAPPROVE === "1"
  ) {
    return;
  }
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "[bench] non-TTY: set BENCH_AUTOAPPROVE=1 to run non-interactively\n",
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

interface EnvCtx {
  unicliBin: string;
  models: string[];
  provider: ProviderCtx;
}

function assertEnv(): EnvCtx {
  if (!process.env.BENCH_API_KEY) {
    process.stderr.write(
      "\n[bench] BENCH_API_KEY is not set.\n" +
        "  export BENCH_API_KEY=<your-key>          # OpenRouter / OpenAI / DeepSeek / Zhipu / Moonshot / Ollama\n" +
        "  export BENCH_BASE_URL=<endpoint>         # optional, defaults to https://openrouter.ai/api/v1\n" +
        "  export BENCH_MODELS=a,b,c                # optional, defaults to DeepSeek + Haiku + GPT-5-mini via OpenRouter\n" +
        "  (Get an OpenRouter key at https://openrouter.ai/keys)\n\n",
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
  return {
    unicliBin,
    models: parseModels(),
    provider: buildProvider(),
  };
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

// ── Corpus runner (per model) ─────────────────────────────────────────────

function sinkPathFor(model: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safe = model.replace(/[^a-z0-9._-]/gi, "_");
  const path = resolve(
    process.cwd(),
    `bench/agent/emissions-${safe}-${ts}.jsonl`,
  );
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

async function runCorpus(ctx: EnvCtx, model: string): Promise<ModelRun> {
  const cells = buildCells();
  const emissionSink = sinkPathFor(model);
  const results: TrialResult[] = [];
  const started = Date.now();
  let retries = 0;
  let cost = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const r = await runWithRetry({
      task: c.task,
      channel: c.channel,
      payload: c.payload,
      trialId: c.trialId,
      unicliBin: ctx.unicliBin,
      modelId: model,
      provider: ctx.provider,
      emissionSink,
    });
    results.push(r.result);
    retries += r.retries;
    cost += r.result.cost_usd;
    if ((i + 1) % 10 === 0 || i === cells.length - 1) {
      const pct = (((i + 1) / cells.length) * 100).toFixed(1);
      const min = ((Date.now() - started) / 60_000).toFixed(1);
      process.stderr.write(
        `[bench][${model}] ${i + 1}/${cells.length} (${pct}%)  elapsed=${min}m  cost=$${cost.toFixed(3)}  retries=${retries}\n`,
      );
    }
  }
  return { model, results, cost, retries, wallMs: Date.now() - started };
}

// ── main / estimate-only ──────────────────────────────────────────────────

function isEstimateOnly(): boolean {
  return process.argv.slice(2).includes("--estimate-only");
}

async function main(): Promise<void> {
  const ctx = assertEnv();
  if (ctx.models.length === 0) {
    process.stderr.write(
      "[bench] BENCH_MODELS resolved to an empty list; nothing to run\n",
    );
    process.exit(78);
  }
  if (isEstimateOnly()) {
    printEstimate(ctx.models);
    process.stderr.write(
      "[bench] --estimate-only: no trials executed; exiting cleanly.\n",
    );
    return;
  }
  await confirmProceed(ctx.models);

  const runs: ModelRun[] = [];
  for (const model of ctx.models) {
    process.stderr.write(`\n[bench] === running model: ${model} ===\n`);
    runs.push(await runCorpus(ctx, model));
  }

  const outPath = resolve(process.cwd(), "bench/agent/results.json");
  const { envelope, totals } = buildReport({
    runs,
    tasks: TASKS,
    provider: PROVIDER_NAME,
    baseUrl: ctx.provider.baseURL,
    models: ctx.models,
    trialsPerCell: TRIALS_PER_CELL,
    channels: CHANNELS.length,
    buckets: 4,
    totalTrialsExpected: perModelTrials() * ctx.models.length,
    outPath,
  });
  const overall = envelope.summary_overall as Record<string, number>;
  process.stderr.write(
    `\n[bench] wrote ${outPath}\n` +
      `[bench] total cost: $${totals.cost.toFixed(3)} over ${(totals.wallMs / 60_000).toFixed(1)} min, ${totals.retries} retries\n` +
      `[bench] models passing gate: ${totals.modelsPassingGate}/${ctx.models.length}\n` +
      `[bench] asr_sem @ICS=8 stdin (avg): ${overall.asr_sem_at_ics8_stdin_avg}\n` +
      `[bench] sed @ICS=8 (avg):            ${overall.sed_at_ics8_avg}\n` +
      `[bench] asr_sem @ICS=2 shell (avg):  ${overall.asr_sem_at_ics2_shell_avg}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`[bench] fatal: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
