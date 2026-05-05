/**
 * Repair command — self-repair broken adapters using AI.
 *
 * unicli repair <site> [command] [options]
 * unicli repair --quarantined            (enumerate quarantine list)
 */

import { readFileSync } from "node:fs";
import type { Command } from "commander";
import chalk from "chalk";
import {
  buildDefaultConfig,
  type RepairConfig,
} from "../engine/repair/config.js";
import { runRepairLoop } from "../engine/repair/engine.js";
import { runEval, type EvalTask } from "../engine/repair/eval.js";
import { discoverQuarantinedAdapters } from "../engine/repair/quarantine-discovery.js";
import { format, detectFormat } from "../output/formatter.js";
import { makeCtx, type AgentContext } from "../output/envelope.js";
import { errorTypeToCode, mapErrorToExitCode } from "../output/error-map.js";
import type { OutputFormat } from "../types.js";

type RepairOptions = {
  max?: string;
  timeout?: string;
  eval?: string;
  loop?: boolean;
  dryRun?: boolean;
  "dry-run"?: boolean;
  quarantined?: boolean;
};

interface RepairCtx {
  ctx: AgentContext;
  fmt: OutputFormat;
  startedAt: number;
}

function emitQuarantinedList(rctx: RepairCtx): number {
  const { adapters, parse_errors } = discoverQuarantinedAdapters();
  const data = {
    mode: "quarantined-list" as const,
    count: adapters.length,
    adapters: adapters.map((q) => ({
      site: q.site,
      command: q.name,
      reason: q.reason,
      adapter_path: q.adapter_path,
      quarantined_since: q.quarantined_since ?? null,
      next_action: `unicli repair ${q.site} ${q.name}`,
    })),
    parse_errors,
  };
  rctx.ctx.duration_ms = Date.now() - rctx.startedAt;
  console.log(format(data, undefined, rctx.fmt, rctx.ctx));
  console.error(
    chalk.dim(
      `\n  ${adapters.length} quarantined adapter(s)` +
        (parse_errors.length > 0
          ? `, ${parse_errors.length} parse error(s) — see parse_errors`
          : "") +
        `. Iterate with "unicli repair <site> <command>" or pipe through xargs.`,
    ),
  );
  return 0;
}

function emitDryRun(
  rctx: RepairCtx,
  site: string,
  command: string | undefined,
  config: RepairConfig,
): void {
  const data = {
    mode: "dry-run" as const,
    site,
    command: command ?? null,
    config: { ...config, metricPattern: config.metricPattern.source },
  };
  rctx.ctx.duration_ms = Date.now() - rctx.startedAt;
  console.log(format(data, undefined, rctx.fmt, rctx.ctx));
  console.error(
    chalk.dim(
      `\n  Dry run — no repairs executed. Max ${config.maxIterations} iterations.`,
    ),
  );
}

function runEvalSuite(
  rctx: RepairCtx,
  site: string,
  command: string | undefined,
  evalPath: string,
): number {
  const raw = readFileSync(evalPath, "utf-8");
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
  rctx.ctx.duration_ms = Date.now() - rctx.startedAt;
  console.log(format(data, undefined, rctx.fmt, rctx.ctx));
  console.error(chalk.dim(`\n  Eval: ${result.score}/${result.total} passed`));
  return result.score === result.total ? 0 : 1;
}

async function runOnceOrLoop(
  rctx: RepairCtx,
  site: string,
  command: string | undefined,
  config: RepairConfig,
  loop: boolean,
): Promise<number> {
  // Single-repair default wraps one iteration; --loop uses the
  // user-supplied max. Progress output from the loop streams to stderr
  // (Scene-6 pattern); the envelope carries the final summary.
  if (!loop) config.maxIterations = 1;
  const result = await runRepairLoop(config);
  const data = {
    mode: loop ? ("loop" as const) : ("once" as const),
    site,
    command: command ?? null,
    iterations: result.iterations,
    best_metric: result.bestMetric,
    improved: result.improved,
  };
  rctx.ctx.duration_ms = Date.now() - rctx.startedAt;
  console.log(format(data, undefined, rctx.fmt, rctx.ctx));
  console.error(
    chalk.dim(
      `\n  Repair ${result.improved ? chalk.green("improved") : chalk.yellow("no-improvement")} — ` +
        `${result.iterations} iteration(s), best ${result.bestMetric}`,
    ),
  );
  return result.improved ? 0 : 1;
}

export function registerRepairCommand(program: Command): void {
  program
    .command("repair [site] [command]")
    .description("Self-repair broken adapters using AI")
    .option("--loop", "Enable autonomous repair loop")
    .option("--max <n>", "Max iterations", "20")
    .option("--timeout <s>", "Per-iteration timeout (seconds)", "90")
    .option("--eval <file>", "Run eval suite from JSON file")
    .option("--dry-run", "Show plan without executing")
    .option(
      "--quarantined",
      "Enumerate every quarantined adapter (ignores <site>/<command>)",
    )
    .action(
      async (
        site: string | undefined,
        command: string | undefined,
        opts: RepairOptions,
      ) => {
        const startedAt = Date.now();
        const ctx = makeCtx("repair.run", startedAt);
        const programOpts = program.opts();
        const fmt = detectFormat(
          programOpts.format as OutputFormat | undefined,
        );
        const rctx: RepairCtx = { ctx, fmt, startedAt };

        // Compute exit code at the end so the success-path process.exit()
        // doesn't pass through the error handler's catch (test harnesses
        // stub process.exit to throw, which would remap exit 0 to 1).
        let successExitCode: number | null = null;

        try {
          if (opts.quarantined === true) {
            successExitCode = emitQuarantinedList(rctx);
          } else if (!site) {
            console.error(
              chalk.red(
                "error: missing required argument 'site' (use --quarantined to enumerate the quarantine list)",
              ),
            );
            process.exit(2);
          } else {
            const config = buildDefaultConfig(site, command);
            config.maxIterations = parseInt(opts.max ?? "", 10) || 20;
            config.timeout = (parseInt(opts.timeout ?? "", 10) || 90) * 1000;

            const isDryRun =
              opts["dry-run"] !== undefined ||
              opts.dryRun !== undefined ||
              programOpts["dry-run"] !== undefined ||
              programOpts.dryRun !== undefined;

            if (isDryRun) {
              emitDryRun(rctx, site, command, config);
              return;
            }

            if (opts.eval) {
              successExitCode = runEvalSuite(rctx, site, command, opts.eval);
            } else {
              successExitCode = await runOnceOrLoop(
                rctx,
                site,
                command,
                config,
                opts.loop !== undefined,
              );
            }
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
