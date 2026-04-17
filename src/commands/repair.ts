/**
 * Repair command — self-repair broken adapters using AI.
 *
 * unicli repair <site> [command] [options]
 */

import { readFileSync } from "node:fs";
import type { Command } from "commander";
import chalk from "chalk";
import { buildDefaultConfig } from "../engine/repair/config.js";
import { runRepairLoop } from "../engine/repair/engine.js";
import { runEval, type EvalTask } from "../engine/repair/eval.js";
import { format, detectFormat } from "../output/formatter.js";
import { makeCtx } from "../output/envelope.js";
import { errorTypeToCode, mapErrorToExitCode } from "../output/error-map.js";
import type { OutputFormat } from "../types.js";

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
        const startedAt = Date.now();
        const ctx = makeCtx("repair.run", startedAt);
        const fmt = detectFormat(
          program.opts().format as OutputFormat | undefined,
        );

        // Declared outside try/catch because the success-path process.exit()
        // must NOT be re-caught and remapped by the error handler (doing so
        // turns exit(0) into exit(1) when tests stub process.exit to throw).
        let successExitCode: number | null = null;

        try {
          const config = buildDefaultConfig(site, command);
          config.maxIterations = parseInt(opts.max, 10) || 20;
          config.timeout = (parseInt(opts.timeout, 10) || 90) * 1000;

          if (opts["dry-run"] !== undefined || opts.dryRun !== undefined) {
            const data = {
              mode: "dry-run" as const,
              site,
              command: command ?? null,
              config: {
                ...config,
                metricPattern: config.metricPattern.source,
              },
            };
            ctx.duration_ms = Date.now() - startedAt;
            console.log(format(data, undefined, fmt, ctx));
            console.error(
              chalk.dim(
                `\n  Dry run — no repairs executed. Max ${config.maxIterations} iterations.`,
              ),
            );
            return;
          }

          if (opts.eval) {
            const raw = readFileSync(opts.eval, "utf-8");
            const tasks = JSON.parse(raw) as EvalTask[];
            const result = runEval(tasks);
            const data = {
              mode: "eval" as const,
              site,
              command: command ?? null,
              score: result.score,
              total: result.total,
              passed: result.score === result.total,
            };
            ctx.duration_ms = Date.now() - startedAt;
            console.log(format(data, undefined, fmt, ctx));
            console.error(
              chalk.dim(`\n  Eval: ${result.score}/${result.total} passed`),
            );
            successExitCode = result.score === result.total ? 0 : 1;
          } else {
            // Single-repair default wraps one iteration; --loop uses the
            // user-supplied max. Progress output from the loop streams to
            // stderr (Scene-6 pattern); the envelope carries the final summary.
            if (opts.loop === undefined) {
              config.maxIterations = 1;
            }
            const result = await runRepairLoop(config);

            const data = {
              mode:
                opts.loop !== undefined ? ("loop" as const) : ("once" as const),
              site,
              command: command ?? null,
              iterations: result.iterations,
              best_metric: result.bestMetric,
              improved: result.improved,
            };

            ctx.duration_ms = Date.now() - startedAt;
            console.log(format(data, undefined, fmt, ctx));

            console.error(
              chalk.dim(
                `\n  Repair ${result.improved ? chalk.green("improved") : chalk.yellow("no-improvement")} — ` +
                  `${result.iterations} iteration(s), best ${result.bestMetric}`,
              ),
            );
            successExitCode = result.improved ? 0 : 1;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.error = {
            code: errorTypeToCode(err),
            message,
            suggestion:
              "Verify the adapter exists (`unicli list`) and retry with --dry-run.",
            retryable: false,
          };
          ctx.duration_ms = Date.now() - startedAt;
          console.error(format(null, undefined, fmt, ctx));
          process.exit(mapErrorToExitCode(err));
        }

        if (successExitCode !== null) process.exit(successExitCode);
      },
    );
}
