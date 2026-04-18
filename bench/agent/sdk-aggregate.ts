/**
 * Aggregation + ship-gate summary for the Claude Agent SDK bench.
 *
 * Rolls per-trial {asr_gen, asr_exec, asr_sem} booleans into per-cell rates
 * with Wilson 95% CIs, and extracts the three headline summary numbers the
 * ship-gate enforcer consumes:
 *   - asr_sem.stdin @ ICS=8 (pathological bucket)
 *   - sed @ ICS=8 (stdin - shell)
 *   - asr_sem.shell @ ICS=2 (trivial bucket)
 */

import { genAllBuckets, type Channel } from "./payload-factory.js";
import type { ICSBreakdown } from "./ics.js";

export interface TrialResult {
  task: { site: string; cmd: string };
  ics_bucket: "trivial" | "moderate" | "hostile" | "pathological";
  channel: Channel;
  trial_id: number;
  asr_gen: boolean;
  asr_exec: boolean;
  asr_sem: boolean;
  duration_ms: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  error?: string;
}

export interface TaskDef {
  site: string;
  cmd: string;
  expected: { minResults: number; keyFields: string[] };
}

export interface AggregateRow {
  site: string;
  cmd: string;
  bucket: "trivial" | "moderate" | "hostile" | "pathological";
  ics_score: number;
  ics_breakdown: Omit<ICSBreakdown, "score">;
  invocation_lengths: Record<Channel, number>;
  asr_gen: Record<Channel, number>;
  asr_exec: Record<Channel, number>;
  asr_sem: Record<Channel, number>;
  n: number;
  "95_ci_asr_sem": Record<Channel, { lo: number; hi: number }>;
}

export interface AggregateSummary {
  asr_sem_at_ics8_stdin: number;
  sed_at_ics8: number;
  asr_sem_at_ics2_shell: number;
}

export function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return round3(xs.reduce((a, b) => a + b, 0) / xs.length);
}

/** Wilson score interval — stable at extremes, suitable for n=10. */
export function binomialCI95(k: number, n: number): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 0 };
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    lo: round3(Math.max(0, (center - half) / denom)),
    hi: round3(Math.min(1, (center + half) / denom)),
  };
}

interface BreakdownIndexEntry {
  breakdown: ICSBreakdown;
  invocationLengths: Record<Channel, number>;
}

function buildBreakdownIndex(
  tasks: readonly TaskDef[],
): Map<string, BreakdownIndexEntry> {
  const idx = new Map<string, BreakdownIndexEntry>();
  for (const t of tasks) {
    for (const p of genAllBuckets(t.site, t.cmd)) {
      idx.set(`${t.site}|${t.cmd}|${p.target}`, {
        breakdown: p.ics,
        invocationLengths: {
          shell: p.invocations.shell.length,
          file: p.invocations.file.length,
          stdin: p.invocations.stdin.length,
        },
      });
    }
  }
  return idx;
}

function rateBy(
  cell: TrialResult[],
  pick: (r: TrialResult) => boolean,
): number {
  return mean(cell.map((r) => (pick(r) ? 1 : 0)));
}

function ciBy(
  cell: TrialResult[],
  pick: (r: TrialResult) => boolean,
): { lo: number; hi: number } {
  return binomialCI95(cell.filter(pick).length, cell.length);
}

function buildRow(
  task: TaskDef,
  bucket: AggregateRow["bucket"],
  cell: TrialResult[],
  idx: BreakdownIndexEntry,
): AggregateRow {
  const byCh: Record<Channel, TrialResult[]> = {
    shell: cell.filter((r) => r.channel === "shell"),
    file: cell.filter((r) => r.channel === "file"),
    stdin: cell.filter((r) => r.channel === "stdin"),
  };
  const { score, ...rest } = idx.breakdown;
  return {
    site: task.site,
    cmd: task.cmd,
    bucket,
    ics_score: score,
    ics_breakdown: rest,
    invocation_lengths: idx.invocationLengths,
    asr_gen: {
      shell: rateBy(byCh.shell, (r) => r.asr_gen),
      file: rateBy(byCh.file, (r) => r.asr_gen),
      stdin: rateBy(byCh.stdin, (r) => r.asr_gen),
    },
    asr_exec: {
      shell: rateBy(byCh.shell, (r) => r.asr_exec),
      file: rateBy(byCh.file, (r) => r.asr_exec),
      stdin: rateBy(byCh.stdin, (r) => r.asr_exec),
    },
    asr_sem: {
      shell: rateBy(byCh.shell, (r) => r.asr_sem),
      file: rateBy(byCh.file, (r) => r.asr_sem),
      stdin: rateBy(byCh.stdin, (r) => r.asr_sem),
    },
    n: byCh.shell.length,
    "95_ci_asr_sem": {
      shell: ciBy(byCh.shell, (r) => r.asr_sem),
      file: ciBy(byCh.file, (r) => r.asr_sem),
      stdin: ciBy(byCh.stdin, (r) => r.asr_sem),
    },
  };
}

export function aggregate(
  tasks: readonly TaskDef[],
  results: TrialResult[],
): { rows: AggregateRow[]; summary: AggregateSummary } {
  const idx = buildBreakdownIndex(tasks);
  const rows: AggregateRow[] = [];
  const buckets: AggregateRow["bucket"][] = [
    "trivial",
    "moderate",
    "hostile",
    "pathological",
  ];
  for (const task of tasks) {
    for (const bucket of buckets) {
      const cell = results.filter(
        (r) =>
          r.task.site === task.site &&
          r.task.cmd === task.cmd &&
          r.ics_bucket === bucket,
      );
      const entry = idx.get(`${task.site}|${task.cmd}|${bucket}`);
      if (cell.length === 0 || !entry) continue;
      rows.push(buildRow(task, bucket, cell, entry));
    }
  }
  return { rows, summary: summarize(rows) };
}

function summarize(rows: AggregateRow[]): AggregateSummary {
  const patho = rows.filter((r) => r.bucket === "pathological");
  const trivial = rows.filter((r) => r.bucket === "trivial");
  const meanOf = (xs: number[]) => (xs.length ? mean(xs) : 0);
  const stdin8 = meanOf(patho.map((r) => r.asr_sem.stdin));
  const shell8 = meanOf(patho.map((r) => r.asr_sem.shell));
  return {
    asr_sem_at_ics8_stdin: round3(stdin8),
    sed_at_ics8: round3(Math.max(0, stdin8 - shell8)),
    asr_sem_at_ics2_shell: round3(meanOf(trivial.map((r) => r.asr_sem.shell))),
  };
}
