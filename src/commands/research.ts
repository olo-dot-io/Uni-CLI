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
    .option("--json", "JSON output")
    .action(
      async (
        site: string,
        command: string | undefined,
        opts: {
          goal?: string;
          iterations: string;
          preset?: string;
          guard?: string;
          json?: boolean;
        },
      ) => {
        // Validate site name to prevent shell injection
        if (!/^[a-zA-Z0-9_-]+$/.test(site)) {
          console.error(
            chalk.red(
              "Invalid site name. Only alphanumeric, hyphens, and underscores allowed.",
            ),
          );
          process.exitCode = 1;
          return;
        }
        const maxIterations = parseInt(opts.iterations, 10) || 10;
        const jsonOnly = opts.json ?? false;

        // Build config from preset or explicit options
        let config: ResearchConfig;

        if (opts.preset) {
          const presetName = opts.preset as PresetName;
          if (
            !["reliability", "coverage", "freshness", "security"].includes(
              presetName,
            )
          ) {
            console.error(
              chalk.red(
                `Unknown preset: ${presetName}. Available: reliability, coverage, freshness, security`,
              ),
            );
            process.exitCode = 1;
            return;
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
          console.error(
            chalk.red(`Adapter directory not found: ${adapterDir}`),
          );
          process.exitCode = 1;
          return;
        }

        if (!jsonOnly) {
          console.error(chalk.cyan(`Research: ${site}`));
          console.error(chalk.dim(`Goal: ${config.goal}`));
          console.error(chalk.dim(`Iterations: ${maxIterations}`));
          console.error("");
        }

        try {
          const results = await runResearchLoop(config, {
            onStatus: (msg) => {
              if (!jsonOnly) console.error(chalk.dim(`  ${msg}`));
            },
            onIteration: (result) => {
              if (jsonOnly) return;
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

          if (jsonOnly) {
            console.log(
              JSON.stringify(
                {
                  site,
                  iterations: results.length - 1,
                  kept,
                  discarded,
                  baselineMetric,
                  finalMetric,
                  improvement: finalMetric - baselineMetric,
                  results,
                },
                null,
                2,
              ),
            );
          } else {
            console.error("");
            console.error(
              chalk.cyan(
                `Done: ${kept} kept, ${discarded} discarded, metric ${baselineMetric} → ${finalMetric}`,
              ),
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (jsonOnly) {
            console.error(JSON.stringify({ error: msg }));
          } else {
            console.error(chalk.red(`Research failed: ${msg}`));
          }
          process.exitCode = 1;
        }
      },
    );

  // Log subcommand
  research
    .command("log")
    .description("Show research improvement history")
    .option("--since <duration>", "time range (e.g. 7d, 24h)", "7d")
    .option("--site <site>", "filter by site")
    .option("--json", "JSON output")
    .action((opts: { since: string; site?: string; json?: boolean }) => {
      const sinceMs = parseSinceDuration(opts.since);
      const log = readResearchLog({ site: opts.site, since: sinceMs });

      if (opts.json) {
        console.log(JSON.stringify(log, null, 2));
        return;
      }

      if (log.length === 0) {
        console.log(chalk.dim("No research history found."));
        return;
      }

      console.log(chalk.cyan(`Research log (since ${opts.since}):`));
      console.log("");
      for (const entry of log) {
        const icon =
          entry.status === "keep"
            ? chalk.green("✓")
            : entry.status === "baseline"
              ? chalk.blue("◎")
              : chalk.red("✗");
        console.log(
          `  ${icon} #${entry.iteration} ${entry.status.padEnd(12)} metric=${entry.metric} ${chalk.dim(entry.description)}`,
        );
      }
    });

  // Report subcommand
  research
    .command("report")
    .description("Aggregate research statistics")
    .option("--json", "JSON output")
    .action((opts: { json?: boolean }) => {
      const log = readResearchLog();

      if (log.length === 0) {
        if (opts.json) {
          console.log(JSON.stringify({ totalIterations: 0 }));
        } else {
          console.log(chalk.dim("No research history found."));
        }
        return;
      }

      const kept = log.filter((r) => r.status === "keep").length;
      const discarded = log.filter((r) => r.status === "discard").length;
      const crashed = log.filter((r) => r.status === "crash").length;
      const totalMs = log.reduce((sum, r) => sum + r.durationMs, 0);

      const report = {
        totalIterations: log.length,
        kept,
        discarded,
        crashed,
        successRate:
          log.length > 0 ? ((kept / log.length) * 100).toFixed(1) + "%" : "0%",
        totalTimeMs: totalMs,
        avgIterationMs: Math.round(totalMs / log.length),
      };

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(chalk.cyan("Research Report:"));
        console.log(`  Total iterations: ${report.totalIterations}`);
        console.log(`  Kept: ${chalk.green(String(kept))}`);
        console.log(`  Discarded: ${chalk.red(String(discarded))}`);
        console.log(`  Crashed: ${chalk.yellow(String(crashed))}`);
        console.log(`  Success rate: ${report.successRate}`);
        console.log(`  Total time: ${Math.round(totalMs / 1000)}s`);
      }
    });
}
