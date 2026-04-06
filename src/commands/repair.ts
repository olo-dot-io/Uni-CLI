/**
 * Repair command — self-repair broken adapters using AI.
 *
 * unicli repair <site> [command] [options]
 */

import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { buildDefaultConfig } from "../engine/repair/config.js";
import { runRepairLoop } from "../engine/repair/engine.js";
import { runEval, type EvalTask } from "../engine/repair/eval.js";

export function registerRepairCommand(program: Command): void {
  program
    .command("repair <site> [command]")
    .description("Self-repair broken adapters using AI")
    .option("--loop", "Enable autonomous repair loop")
    .option("--max <n>", "Max iterations", "20")
    .option("--timeout <s>", "Per-iteration timeout (seconds)", "90")
    .option("--eval <file>", "Run eval suite from JSON file")
    .option("--dry-run", "Show plan without executing")
    .action(
      async (
        site: string,
        command: string | undefined,
        opts: Record<string, string>,
      ) => {
        const config = buildDefaultConfig(site, command);
        config.maxIterations = parseInt(opts.max, 10) || 20;
        config.timeout = (parseInt(opts.timeout, 10) || 90) * 1000;

        if (opts["dry-run"] !== undefined || opts.dryRun !== undefined) {
          // Print config (serialize RegExp as source string)
          const serializable = {
            ...config,
            metricPattern: config.metricPattern.source,
          };
          console.log(JSON.stringify(serializable, null, 2));
          return;
        }

        if (opts.eval) {
          const raw = readFileSync(opts.eval, "utf-8");
          const tasks = JSON.parse(raw) as EvalTask[];
          const result = runEval(tasks);
          process.exit(result.score === result.total ? 0 : 1);
        }

        if (opts.loop !== undefined) {
          const result = await runRepairLoop(config);
          console.log(
            `Repair complete: ${result.iterations} iterations, best score: ${result.bestMetric}`,
          );
          process.exit(result.improved ? 0 : 1);
        } else {
          // Single repair: just run one iteration
          config.maxIterations = 1;
          const result = await runRepairLoop(config);
          process.exit(result.improved ? 0 : 1);
        }
      },
    );
}
