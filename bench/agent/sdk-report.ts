/**
 * Report writer for the multi-model bench.
 *
 * Folds per-model TrialResult batches into an AggregateRow/AggregateSummary
 * per model, tacks on cost + retries + wall time, and produces the final
 * bench-v3 results.json envelope with a summary_overall block.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  aggregate,
  type AggregateRow,
  type AggregateSummary,
  type TaskDef,
  type TrialResult,
} from "./sdk-aggregate.js";

export const GATE_REQS = {
  asr_sem_at_ics8_stdin: 0.95,
  sed_at_ics8: 0.3,
  asr_sem_at_ics2_shell: 0.9,
} as const;

export interface ModelRun {
  model: string;
  results: TrialResult[];
  cost: number;
  retries: number;
  wallMs: number;
}

export type PerModelSummary = AggregateSummary & {
  cost_usd: number;
  retries: number;
  wall_time_minutes: number;
  passes_gate: boolean;
};

export interface PerModelEntry {
  rows: AggregateRow[];
  summary: PerModelSummary;
}

interface Totals {
  byModel: Record<string, PerModelEntry>;
  modelsPassingGate: number;
  cost: number;
  retries: number;
  wallMs: number;
  trials: number;
  stdin8: number[];
  sed8: number[];
  shell2: number[];
}

export function modelPassesGate(summary: AggregateSummary): boolean {
  return (
    summary.asr_sem_at_ics8_stdin >= GATE_REQS.asr_sem_at_ics8_stdin &&
    summary.sed_at_ics8 >= GATE_REQS.sed_at_ics8 &&
    summary.asr_sem_at_ics2_shell >= GATE_REQS.asr_sem_at_ics2_shell
  );
}

export function roundMoney(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function avgArr(xs: number[]): number {
  if (xs.length === 0) return 0;
  return Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000;
}

function foldRuns(runs: ModelRun[], tasks: readonly TaskDef[]): Totals {
  const t: Totals = {
    byModel: {},
    modelsPassingGate: 0,
    cost: 0,
    retries: 0,
    wallMs: 0,
    trials: 0,
    stdin8: [],
    sed8: [],
    shell2: [],
  };
  for (const run of runs) {
    const { rows, summary } = aggregate(tasks, run.results);
    const passes = modelPassesGate(summary);
    if (passes) t.modelsPassingGate++;
    t.byModel[run.model] = {
      rows,
      summary: {
        ...summary,
        cost_usd: roundMoney(run.cost),
        retries: run.retries,
        wall_time_minutes: roundMoney(run.wallMs / 60_000),
        passes_gate: passes,
      },
    };
    t.stdin8.push(summary.asr_sem_at_ics8_stdin);
    t.sed8.push(summary.sed_at_ics8);
    t.shell2.push(summary.asr_sem_at_ics2_shell);
    t.cost += run.cost;
    t.retries += run.retries;
    t.wallMs += run.wallMs;
    t.trials += run.results.length;
  }
  return t;
}

export interface ReportArgs {
  runs: ModelRun[];
  tasks: readonly TaskDef[];
  provider: string;
  baseUrl: string;
  models: string[];
  trialsPerCell: number;
  channels: number;
  buckets: number;
  totalTrialsExpected: number;
  outPath: string;
}

export function buildReport(args: ReportArgs): {
  path: string;
  totals: Totals;
  envelope: Record<string, unknown>;
} {
  const t = foldRuns(args.runs, args.tasks);
  const envelope = {
    schema_version: "bench-v3",
    generated_at: new Date().toISOString(),
    provider: args.provider,
    base_url: args.baseUrl,
    models: args.models,
    tasks: args.tasks.length,
    trials_per_cell: args.trialsPerCell,
    channels: args.channels,
    buckets: args.buckets,
    total_trials: t.trials,
    expected_trials: args.totalTrialsExpected,
    total_cost_usd: roundMoney(t.cost),
    total_retries: t.retries,
    total_wall_time_minutes: roundMoney(t.wallMs / 60_000),
    by_model: t.byModel,
    summary_overall: {
      asr_sem_at_ics8_stdin_avg: avgArr(t.stdin8),
      sed_at_ics8_avg: avgArr(t.sed8),
      asr_sem_at_ics2_shell_avg: avgArr(t.shell2),
      models_passing_gate: t.modelsPassingGate,
      models_total: args.models.length,
    },
  };
  mkdirSync(dirname(args.outPath), { recursive: true });
  writeFileSync(args.outPath, JSON.stringify(envelope, null, 2) + "\n");
  return { path: args.outPath, totals: t, envelope };
}
