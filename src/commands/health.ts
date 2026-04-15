/**
 * Health check CLI command — batch-test adapter pipelines.
 *
 * Command:
 *   unicli health [site]  — Run all adapter pipelines and report status
 *
 * Options:
 *   --failing-only  — Show only broken adapters
 *   --timeout <ms>  — Per-command timeout (default: 10000)
 *   --json          — Output JSON only
 */

import { Command } from "commander";
import chalk from "chalk";
import { getAllAdapters } from "../registry.js";
import { runPipeline, PipelineError } from "../engine/executor.js";
import { format, detectFormat } from "../output/formatter.js";
import { AdapterType, ExitCode } from "../types.js";
import type { OutputFormat } from "../types.js";

interface HealthResult {
  site: string;
  command: string;
  status: "ok" | "fail" | "skip";
  latency: number;
  error?: string;
}

/** Race a promise against a timeout */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Check if a command requires browser interaction */
function requiresBrowser(adapterType: AdapterType, strategy?: string): boolean {
  return (
    adapterType === AdapterType.BROWSER ||
    strategy === "intercept" ||
    strategy === "ui"
  );
}

export function registerHealthCommand(program: Command): void {
  program
    .command("health [site]")
    .description("Check adapter health — run all pipelines and report status")
    .option("--failing-only", "show only broken adapters")
    .option("--timeout <ms>", "per-command timeout in ms", "10000")
    .option("--json", "output JSON only")
    .action(
      async (
        site: string | undefined,
        opts: { failingOnly?: boolean; timeout: string; json?: boolean },
      ) => {
        const timeout = parseInt(opts.timeout, 10) || 10000;
        const adapters = site
          ? getAllAdapters().filter((a) => a.name === site)
          : getAllAdapters();

        if (adapters.length === 0) {
          console.error(
            chalk.red(site ? `Unknown site: ${site}` : "No adapters loaded"),
          );
          process.exit(ExitCode.USAGE_ERROR);
        }

        const results: HealthResult[] = [];

        for (const adapter of adapters) {
          for (const [cmdName, cmd] of Object.entries(adapter.commands)) {
            // Skip quarantined adapters — they are intentionally parked
            // until an agent repairs them; failing-only mode hides them too.
            if (cmd.quarantine) {
              results.push({
                site: adapter.name,
                command: cmdName,
                status: "skip",
                latency: 0,
                error: cmd.quarantineReason
                  ? `quarantined: ${cmd.quarantineReason}`
                  : "quarantined",
              });
              continue;
            }

            // Skip TypeScript function commands (no pipeline)
            if (!cmd.pipeline) {
              results.push({
                site: adapter.name,
                command: cmdName,
                status: "skip",
                latency: 0,
                error: "TS func (no pipeline)",
              });
              continue;
            }

            // Skip browser-only commands
            if (requiresBrowser(adapter.type, adapter.strategy as string)) {
              results.push({
                site: adapter.name,
                command: cmdName,
                status: "skip",
                latency: 0,
                error: "requires browser",
              });
              continue;
            }

            // Skip commands that require positional args
            const requiredArgs = (cmd.adapterArgs ?? []).filter(
              (a) => a.required && a.positional,
            );
            if (requiredArgs.length > 0) {
              results.push({
                site: adapter.name,
                command: cmdName,
                status: "skip",
                latency: 0,
                error: `requires args: ${requiredArgs.map((a) => a.name).join(", ")}`,
              });
              continue;
            }

            const start = performance.now();
            try {
              await withTimeout(
                runPipeline(cmd.pipeline, { limit: 1 }, adapter.base, {
                  site: adapter.name,
                  strategy: adapter.strategy as string,
                }),
                timeout,
              );
              results.push({
                site: adapter.name,
                command: cmdName,
                status: "ok",
                latency: Math.round(performance.now() - start),
              });
            } catch (err) {
              const message =
                err instanceof PipelineError
                  ? err.message
                  : err instanceof Error
                    ? err.message
                    : String(err);
              results.push({
                site: adapter.name,
                command: cmdName,
                status: "fail",
                latency: Math.round(performance.now() - start),
                error: message.slice(0, 120),
              });
            }
          }
        }

        // Filter if --failing-only
        const display = opts.failingOnly
          ? results.filter((r) => r.status === "fail")
          : results;

        // Determine output format
        const fmt: OutputFormat = opts.json
          ? "json"
          : detectFormat(program.opts().format as OutputFormat | undefined);

        if (fmt === "json") {
          console.log(JSON.stringify(display, null, 2));
        } else {
          console.log(
            format(
              display.map((r) => ({
                site: r.site,
                command: r.command,
                status:
                  r.status === "ok"
                    ? chalk.green("ok")
                    : r.status === "fail"
                      ? chalk.red("FAIL")
                      : chalk.dim("skip"),
                latency: r.status === "skip" ? "-" : `${r.latency}ms`,
                error: r.error ?? "",
              })),
              ["site", "command", "status", "latency", "error"],
              fmt,
            ),
          );

          // Summary
          const ok = results.filter((r) => r.status === "ok").length;
          const fail = results.filter((r) => r.status === "fail").length;
          const skip = results.filter((r) => r.status === "skip").length;
          console.log(
            chalk.bold(
              `\nHealth: ${chalk.green(ok + " ok")}, ${chalk.red(fail + " fail")}, ${chalk.dim(skip + " skip")}`,
            ),
          );
        }

        const hasFailing = results.some((r) => r.status === "fail");
        process.exit(hasFailing ? ExitCode.GENERIC_ERROR : ExitCode.SUCCESS);
      },
    );
}
