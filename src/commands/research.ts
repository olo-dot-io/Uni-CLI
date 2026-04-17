/**
 * Research CLI command — Karpathy-style self-improvement loop.
 *
 * Commands:
 *   unicli research <site> [command]    — improve a specific adapter
 *   unicli research log [--since 7d]    — show improvement history
 *   unicli research report              — aggregate stats
 *
 * Options:
 *   --goal <goal>         — what to improve (default: "increase eval score")
 *   --iterations <n>      — max iterations (default: 10)
 *   --preset <name>       — use preset config (reliability, coverage, freshness, security)
 *   --guard <cmd>         — regression guard command
 */

import { Command } from "commander";
import chalk from "chalk";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  runResearchLoop,
  readResearchLog,
  type ResearchConfig,
} from "../engine/research.js";
import { ExitCode } from "../types.js";
import type { OutputFormat } from "../types.js";
import { format, detectFormat } from "../output/formatter.js";
import { makeCtx } from "../output/envelope.js";
import { errorTypeToCode, mapErrorToExitCode } from "../output/error-map.js";

// ── Presets ──────────────────────────────────────────────────────────────

type PresetName = "reliability" | "coverage" | "freshness" | "security";

function buildPresetConfig(
  preset: PresetName,
  site: string,
): Partial<ResearchConfig> {
  switch (preset) {
    case "reliability":
      return {
        goal: "Improve eval pass rate — fix failing assertions, update selectors, handle empty responses",
        verify: `unicli eval run ${site} --json 2>&1`,
        scope: [`src/adapters/${site}/*.yaml`, `src/adapters/${site}/*.ts`],
      };
    case "coverage":
      return {
        goal: "Add more capabilities — discover new endpoints and generate adapters for them",
        verify: `unicli eval run ${site} --json 2>&1`,
        scope: [`src/adapters/${site}/*.yaml`],
      };
    case "freshness":
      return {
        goal: "Update stale selectors and API endpoints — fix any 404, 403, or empty results",
        verify: `unicli eval run ${site} --json 2>&1`,
        scope: [`src/adapters/${site}/*.yaml`],
      };
    case "security":
      return {
        goal: "Audit for shell injection vectors — ensure no raw arg interpolation in exec steps",
        verify: `unicli eval run ${site} --json 2>&1`,
        scope: [`src/adapters/${site}/*.yaml`],
      };
  }
}

// ── Duration Formatting ─────────────────────────────────────────────────

function parseSinceDuration(since: string): number {
  const match = /^(\d+)([dhm])$/.exec(since);
  if (!match) return Date.now() - 7 * 24 * 60 * 60 * 1000; // default 7d
  const val = parseInt(match[1], 10);
  const unit = match[2];
  const ms =
    unit === "d"
      ? val * 86_400_000
      : unit === "h"
        ? val * 3_600_000
        : val * 60_000;
  return Date.now() - ms;
}

// ── Command Registration ────────────────────────────────────────────────

export function registerResearchCommand(program: Command): void {
  const research = program
    .command("research")
    .description("Self-improvement loop for adapter quality");

  // Main research command
  research
    .command("run <site> [command]")
    .description("Run research loop to improve an adapter")
    .option("--goal <goal>", "improvement goal")
    .option("--iterations <n>", "max iterations", "10")
    .option(
      "--preset <name>",
      "preset config (reliability|coverage|freshness|security)",
    )
    .option("--guard <cmd>", "regression guard command")
    .action(
      async (
        site: string,
        command: string | undefined,
        opts: {
          goal?: string;
          iterations: string;
          preset?: string;
          guard?: string;
        },
      ) => {
        const startedAt = Date.now();
        const ctx = makeCtx("research.run", startedAt);
        const fmt = detectFormat(
          program.opts().format as OutputFormat | undefined,
        );

        // Validate site name to prevent shell injection
        if (!/^[a-zA-Z0-9_-]+$/.test(site)) {
          ctx.error = {
            code: "invalid_input",
            message:
              "Invalid site name. Only alphanumeric, hyphens, and underscores allowed.",
            suggestion: "Pass a site name like 'twitter' or 'hackernews'.",
            retryable: false,
          };
          ctx.duration_ms = Date.now() - startedAt;
          console.error(format(null, undefined, fmt, ctx));
          process.exit(ExitCode.USAGE_ERROR);
        }
        const maxIterations = parseInt(opts.iterations, 10) || 10;

        // Build config from preset or explicit options
        let config: ResearchConfig;

        if (opts.preset) {
          const presetName = opts.preset as PresetName;
          if (
            !["reliability", "coverage", "freshness", "security"].includes(
              presetName,
            )
          ) {
            ctx.error = {
              code: "invalid_input",
              message: `Unknown preset: ${presetName}`,
              suggestion:
                "Use one of: reliability, coverage, freshness, security",
              retryable: false,
            };
            ctx.duration_ms = Date.now() - startedAt;
            console.error(format(null, undefined, fmt, ctx));
            process.exit(ExitCode.USAGE_ERROR);
          }
          const preset = buildPresetConfig(presetName, site);
          config = {
            site,
            command,
            goal: opts.goal ?? preset.goal ?? "improve adapter",
            verify: preset.verify ?? `unicli eval run ${site} --json 2>&1`,
            guard: opts.guard,
            scope: preset.scope ?? [`src/adapters/${site}/*.yaml`],
            metric: "SCORE=(\\d+)",
            direction: "higher",
            maxIterations,
            minDelta: 0,
          };
        } else {
          config = {
            site,
            command,
            goal:
              opts.goal ??
              "Increase eval score — fix failing adapters, improve data quality",
            verify: `unicli eval run ${site} --json 2>&1`,
            guard: opts.guard,
            scope: [`src/adapters/${site}/*.yaml`, `src/adapters/${site}/*.ts`],
            metric: "SCORE=(\\d+)",
            direction: "higher",
            maxIterations,
            minDelta: 0,
          };
        }

        // Validate adapter exists
        const adapterDir = join("src", "adapters", site);
        if (!existsSync(adapterDir)) {
          ctx.error = {
            code: "not_found",
            message: `Adapter directory not found: ${adapterDir}`,
            suggestion: `Check the site name or run: unicli list`,
            retryable: false,
          };
          ctx.duration_ms = Date.now() - startedAt;
          console.error(format(null, undefined, fmt, ctx));
          process.exit(ExitCode.USAGE_ERROR);
        }

        // Human-oriented header → stderr (Scene-6 pattern)
        console.error(chalk.cyan(`Research: ${site}`));
        console.error(chalk.dim(`Goal: ${config.goal}`));
        console.error(chalk.dim(`Iterations: ${maxIterations}`));
        console.error("");

        try {
          const results = await runResearchLoop(config, {
            onStatus: (msg) => {
              console.error(chalk.dim(`  ${msg}`));
            },
            onIteration: (result) => {
              const icon =
                result.status === "keep"
                  ? chalk.green("✓")
                  : result.status === "discard"
                    ? chalk.red("✗")
                    : chalk.yellow("·");
              console.error(
                `  ${icon} #${result.iteration} ${result.status} metric=${result.metric} ${chalk.dim(result.description)}`,
              );
            },
          });

          // Summary
          const kept = results.filter((r) => r.status === "keep").length;
          const discarded = results.filter(
            (r) => r.status === "discard",
          ).length;
          const finalMetric = results[results.length - 1]?.metric ?? 0;
          const baselineMetric = results[0]?.metric ?? 0;

          const data = {
            site,
            iterations: results.length - 1,
            kept,
            discarded,
            baseline_metric: baselineMetric,
            final_metric: finalMetric,
            improvement: finalMetric - baselineMetric,
            results,
          };

          ctx.duration_ms = Date.now() - startedAt;
          console.log(format(data, undefined, fmt, ctx));

          console.error("");
          console.error(
            chalk.cyan(
              `Done: ${kept} kept, ${discarded} discarded, metric ${baselineMetric} → ${finalMetric}`,
            ),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.error = {
            code: errorTypeToCode(err),
            message,
            suggestion: `Re-run with --preset reliability, or inspect ${join("src", "adapters", site)}`,
            retryable: false,
          };
          ctx.duration_ms = Date.now() - startedAt;
          console.error(format(null, undefined, fmt, ctx));
          process.exit(mapErrorToExitCode(err));
        }
      },
    );

  // Log subcommand
  research
    .command("log")
    .description("Show research improvement history")
    .option("--since <duration>", "time range (e.g. 7d, 24h)", "7d")
    .option("--site <site>", "filter by site")
    .action((opts: { since: string; site?: string }) => {
      const startedAt = Date.now();
      const ctx = makeCtx("research.log", startedAt);
      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );

      const sinceMs = parseSinceDuration(opts.since);
      const log = readResearchLog({ site: opts.site, since: sinceMs });

      ctx.duration_ms = Date.now() - startedAt;
      console.log(
        format(log, ["iteration", "status", "metric", "description"], fmt, ctx),
      );

      if (log.length === 0) {
        console.error(chalk.dim("\n  No research history found."));
      } else {
        console.error(
          chalk.dim(`\n  ${log.length} entry(ies) since ${opts.since}`),
        );
      }
    });

  // Report subcommand
  research
    .command("report")
    .description("Aggregate research statistics")
    .action(() => {
      const startedAt = Date.now();
      const ctx = makeCtx("research.report", startedAt);
      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );

      const log = readResearchLog();

      if (log.length === 0) {
        const data = {
          total_iterations: 0,
          kept: 0,
          discarded: 0,
          crashed: 0,
          success_rate: "0%",
          total_time_ms: 0,
          avg_iteration_ms: 0,
        };
        ctx.duration_ms = Date.now() - startedAt;
        console.log(format(data, undefined, fmt, ctx));
        console.error(chalk.dim("\n  No research history found."));
        return;
      }

      const kept = log.filter((r) => r.status === "keep").length;
      const discarded = log.filter((r) => r.status === "discard").length;
      const crashed = log.filter((r) => r.status === "crash").length;
      const totalMs = log.reduce((sum, r) => sum + r.durationMs, 0);

      const data = {
        total_iterations: log.length,
        kept,
        discarded,
        crashed,
        success_rate: ((kept / log.length) * 100).toFixed(1) + "%",
        total_time_ms: totalMs,
        avg_iteration_ms: Math.round(totalMs / log.length),
      };

      ctx.duration_ms = Date.now() - startedAt;
      console.log(format(data, undefined, fmt, ctx));

      console.error(
        chalk.dim(
          `\n  ${log.length} total: ${chalk.green(String(kept))} kept, ${chalk.red(String(discarded))} discarded, ${chalk.yellow(String(crashed))} crashed`,
        ),
      );
    });
}
