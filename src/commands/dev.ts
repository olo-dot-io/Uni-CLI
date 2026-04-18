/**
 * Dev command — hot-reload mode for adapter development.
 *
 * Usage:
 *   unicli dev <path> [--format table|json|yaml|csv]
 *
 * Watches a YAML adapter file and re-executes its pipeline on every save.
 */

import { Command } from "commander";
import chalk from "chalk";
import { watch, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { load as yamlLoad } from "js-yaml";
import type { PipelineStep } from "../types.js";

export function registerDevCommand(program: Command): void {
  program
    .command("dev <path>")
    .description("Develop an adapter with hot-reload")
    .option(
      "--format <format>",
      "Output format (table|json|yaml|csv|md|compact)",
      "md",
    )
    .action(async (filePath: string, opts: { format: string }) => {
      const absPath = resolve(filePath);
      if (!existsSync(absPath)) {
        console.error(chalk.red(`File not found: ${absPath}`));
        process.exitCode = 1;
        return;
      }

      console.log(chalk.green(`Watching ${absPath}`));
      console.log(chalk.dim("Save the file to re-execute. Ctrl+C to stop.\n"));

      await runAdapter(absPath, opts.format);

      let debounce: ReturnType<typeof setTimeout> | null = null;
      watch(absPath, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(async () => {
          console.log(chalk.dim("\n--- reload ---\n"));
          await runAdapter(absPath, opts.format);
        }, 300);
      });
    });
}

async function runAdapter(filePath: string, fmt: string): Promise<void> {
  try {
    const { runPipeline } = await import("../engine/executor.js");
    const { format, detectFormat } = await import("../output/formatter.js");

    const raw = readFileSync(filePath, "utf-8");
    const doc = yamlLoad(raw) as Record<string, unknown>;
    const pipeline = doc.pipeline as PipelineStep[];

    if (!pipeline) {
      console.error(chalk.red("No pipeline found in YAML"));
      return;
    }

    const devStarted = Date.now();
    const result = await runPipeline(
      pipeline,
      { args: {}, source: "internal" },
      undefined,
      {
        site: doc.site as string,
        strategy: doc.strategy as string,
      },
    );

    const columns = doc.columns as string[] | undefined;
    const outputFmt = detectFormat(
      fmt as "table" | "json" | "yaml" | "csv" | "md" | undefined,
    );
    console.log(
      format(result, columns, outputFmt, {
        command: "dev.watch",
        duration_ms: Date.now() - devStarted,
        surface: "web",
      }),
    );
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
  }
}
