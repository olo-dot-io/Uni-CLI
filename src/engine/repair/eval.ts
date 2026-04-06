/**
 * Eval suite runner for the self-repair loop.
 * Runs a set of adapter commands and judges their output.
 */

import { execSync } from "node:child_process";

export type EvalJudge =
  | { type: "contains"; value: string }
  | { type: "arrayMinLength"; value: number }
  | { type: "nonEmpty" }
  | { type: "matchesPattern"; value: string };

export interface EvalTask {
  name: string;
  command: string;
  args?: string[];
  judge: EvalJudge;
}

export interface EvalResult {
  task: EvalTask;
  passed: boolean;
  output?: string;
  error?: string;
}

/**
 * Run an eval suite of tasks and return the score.
 * Prints SCORE=N/M to stdout for metric extraction.
 */
export function runEval(tasks: EvalTask[]): {
  score: number;
  total: number;
  results: EvalResult[];
} {
  let passed = 0;
  const results: EvalResult[] = [];

  for (const task of tasks) {
    try {
      const cmd = task.args
        ? `${task.command} ${task.args.join(" ")}`
        : task.command;
      const output = execSync(cmd, {
        encoding: "utf-8",
        timeout: 30_000,
      });
      const ok = judgeOutput(output, task.judge);
      if (ok) passed++;
      results.push({
        task,
        passed: ok,
        output: output.slice(0, 1000),
      });
    } catch (e) {
      results.push({
        task,
        passed: false,
        error: String(e).slice(0, 500),
      });
    }
  }

  console.log(`SCORE=${passed}/${tasks.length}`);
  return { score: passed, total: tasks.length, results };
}

/**
 * Judge command output against a criterion.
 */
export function judgeOutput(output: string, judge: EvalJudge): boolean {
  switch (judge.type) {
    case "contains":
      return output.includes(judge.value);

    case "nonEmpty":
      return output.trim().length > 0;

    case "arrayMinLength": {
      try {
        const arr: unknown = JSON.parse(output);
        return Array.isArray(arr) && arr.length >= judge.value;
      } catch {
        return false;
      }
    }

    case "matchesPattern":
      return new RegExp(judge.value).test(output);
  }
}
