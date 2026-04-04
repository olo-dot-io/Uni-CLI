/**
 * CLI entry point — Commander-based routing with dynamic adapter commands.
 */

import { Command } from "commander";
import chalk from "chalk";
import { loadAllAdapters } from "./discovery/loader.js";
import { getAllAdapters, listCommands, resolveCommand } from "./registry.js";
import { format, detectFormat } from "./output/formatter.js";
import { runPipeline, PipelineError } from "./engine/yaml-runner.js";
import { ExitCode } from "./types.js";
import { VERSION } from "./constants.js";
import type { OutputFormat } from "./types.js";

export function createCli(): Command {
  const program = new Command();

  program
    .name("unicli")
    .description("CLI IS ALL YOU NEED — Universal CLI for AI agents")
    .version(VERSION)
    .option(
      "-f, --format <format>",
      "output format: table, json, yaml, csv, md",
    )
    .option("-v, --verbose", "show pipeline debug steps");

  // Load adapters before parsing
  const adapterCount = loadAllAdapters();

  // Register "list" command
  program
    .command("list")
    .description("List all available commands")
    .option("--site <site>", "filter by site name")
    .option("--type <type>", "filter by adapter type")
    .action((opts) => {
      let commands = listCommands();

      if (opts.site) {
        commands = commands.filter((c) => c.site.includes(opts.site));
      }
      if (opts.type) {
        commands = commands.filter((c) => c.type === opts.type);
      }

      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );
      const rows = commands.map((c) => ({
        site: c.site,
        command: c.command,
        description: c.description,
        type: c.type,
        auth: c.auth ? "[auth]" : "",
      }));

      console.log(
        format(rows, ["site", "command", "description", "type", "auth"], fmt),
      );
    });

  // Register "doctor" command
  program
    .command("doctor")
    .description("Check extension + daemon connectivity")
    .action(() => {
      console.log(chalk.bold("unicli doctor"));
      console.log(`  Adapters loaded: ${chalk.green(adapterCount)}`);
      console.log(`  Sites: ${chalk.green(getAllAdapters().length)}`);
      console.log(`  Node.js: ${chalk.green(process.version)}`);
      console.log(`  Platform: ${chalk.green(process.platform)}`);
    });

  // Register "repair" command — diagnostic for broken adapters
  program
    .command("repair <site> <command>")
    .description("Diagnose and suggest fixes for a broken adapter command")
    .option("--verbose", "show full pipeline trace")
    .action(
      async (
        site: string,
        commandName: string,
        opts: Record<string, unknown>,
      ) => {
        const resolved = resolveCommand(site, commandName);
        if (!resolved) {
          console.error(chalk.red(`Unknown command: ${site} ${commandName}`));
          console.error(
            chalk.dim(
              `Available sites: ${getAllAdapters()
                .map((a) => a.name)
                .join(", ")}`,
            ),
          );
          process.exit(ExitCode.USAGE_ERROR);
        }

        const { adapter, command } = resolved;
        const adapterPath = `src/adapters/${adapter.name}/${commandName}.yaml`;

        console.log(chalk.bold(`Diagnosing: unicli ${site} ${commandName}`));
        console.log(chalk.dim(`  adapter: ${adapterPath}`));
        console.log(chalk.dim(`  type: ${adapter.type}`));
        console.log(chalk.dim(`  strategy: ${adapter.strategy ?? "public"}`));

        if (!command.pipeline) {
          console.log(
            chalk.yellow(
              "  This command uses a TypeScript function, not a YAML pipeline.",
            ),
          );
          console.log(
            chalk.yellow(
              "  Self-repair is only available for YAML pipeline adapters.",
            ),
          );
          process.exit(ExitCode.CONFIG_ERROR);
        }

        console.log(chalk.dim(`  pipeline steps: ${command.pipeline.length}`));
        console.log("");

        // Run pipeline with verbose tracing
        try {
          console.log(chalk.cyan("Running pipeline..."));
          const results = await runPipeline(
            command.pipeline,
            { limit: 3 },
            adapter.base,
          );
          console.log(
            chalk.green(`  ✓ Pipeline succeeded — ${results.length} result(s)`),
          );
          if (results.length > 0 && opts.verbose) {
            console.log(chalk.dim(JSON.stringify(results[0], null, 2)));
          }
        } catch (err) {
          if (err instanceof PipelineError) {
            const info = err.toAgentJSON(adapterPath);
            console.log(
              chalk.red(
                `  ✗ Pipeline failed at step ${info.step} (${info.action})`,
              ),
            );
            console.log(chalk.red(`    ${err.message}`));
            if (info.url) console.log(chalk.dim(`    url: ${info.url}`));
            if (info.statusCode)
              console.log(chalk.dim(`    status: ${info.statusCode}`));
            if (info.responsePreview)
              console.log(
                chalk.dim(
                  `    response: ${info.responsePreview.slice(0, 100)}`,
                ),
              );
            console.log("");
            console.log(chalk.yellow("  Suggested fix:"));
            console.log(chalk.yellow(`    ${info.suggestion}`));
            console.log("");
            console.log(chalk.dim(`  To fix: edit ${adapterPath}`));

            // Output JSON for AI agents
            if (!process.stdout.isTTY) {
              console.log(JSON.stringify(info, null, 2));
            }
          } else {
            console.error(
              chalk.red(
                `  ✗ ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
          }
          process.exit(ExitCode.GENERIC_ERROR);
        }
      },
    );

  // Register "test" command — run all commands for a site
  program
    .command("test [site]")
    .description("Test adapter commands (run all or for a specific site)")
    .option("--timeout <ms>", "timeout per command in ms", "15000")
    .action(async (site: string | undefined, opts: Record<string, string>) => {
      const timeout = parseInt(opts.timeout, 10) || 15000;
      const adaptersToTest = site
        ? getAllAdapters().filter((a) => a.name === site)
        : getAllAdapters();

      if (adaptersToTest.length === 0) {
        console.error(
          chalk.red(site ? `Unknown site: ${site}` : "No adapters loaded"),
        );
        process.exit(ExitCode.USAGE_ERROR);
      }

      let passed = 0;
      let failed = 0;
      let skipped = 0;

      for (const adapter of adaptersToTest) {
        console.log(chalk.bold(`\n${adapter.name}`));

        for (const [cmdName, cmd] of Object.entries(adapter.commands)) {
          if (!cmd.pipeline) {
            console.log(chalk.dim(`  ${cmdName}: skip (TS func)`));
            skipped++;
            continue;
          }

          // Skip commands that require positional args (can't test without input)
          const requiredArgs = (cmd.adapterArgs ?? []).filter(
            (a) => a.required && a.positional,
          );
          if (requiredArgs.length > 0) {
            console.log(
              chalk.dim(
                `  ${cmdName}: skip (requires: ${requiredArgs.map((a) => a.name).join(", ")})`,
              ),
            );
            skipped++;
            continue;
          }

          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeout);

            const results = await runPipeline(
              cmd.pipeline,
              { limit: 2 },
              adapter.base,
            );
            clearTimeout(timer);

            if (results.length > 0) {
              console.log(
                chalk.green(`  ${cmdName}: ✓ (${results.length} results)`),
              );
              passed++;
            } else {
              console.log(chalk.yellow(`  ${cmdName}: ✓ (empty)`));
              passed++;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(chalk.red(`  ${cmdName}: ✗ ${msg.slice(0, 80)}`));
            failed++;
          }
        }
      }

      console.log(
        chalk.bold(
          `\nResults: ${chalk.green(passed + " passed")}, ${chalk.red(failed + " failed")}, ${chalk.dim(skipped + " skipped")}`,
        ),
      );
      process.exit(failed > 0 ? ExitCode.GENERIC_ERROR : ExitCode.SUCCESS);
    });

  // Dynamic site commands — register a command for each adapter
  for (const adapter of getAllAdapters()) {
    const siteCmd = program
      .command(adapter.name)
      .description(
        adapter.description ??
          `Commands for ${adapter.displayName ?? adapter.name}`,
      );

    for (const [cmdName, cmd] of Object.entries(adapter.commands)) {
      let cmdStr = cmdName;

      // Register positional arguments from adapter definition
      const adapterArgs = cmd.adapterArgs ?? [];
      for (const arg of adapterArgs) {
        if (arg.positional) {
          cmdStr += arg.required ? ` <${arg.name}>` : ` [${arg.name}]`;
        }
      }

      const subCmd = siteCmd.command(cmdStr).description(cmd.description ?? "");

      // Register option arguments
      const registeredOpts = new Set<string>();
      subCmd.option("--limit <n>", "limit results", "20");
      registeredOpts.add("limit");

      for (const arg of adapterArgs) {
        if (!arg.positional && !registeredOpts.has(arg.name)) {
          const flag = `--${arg.name} <value>`;
          const desc = arg.description ?? "";
          registeredOpts.add(arg.name);
          if (arg.default !== undefined) {
            subCmd.option(flag, desc, String(arg.default));
          } else {
            subCmd.option(flag, desc);
          }
        }
      }

      subCmd.action(async (...actionArgs: unknown[]) => {
        // Commander passes positional args first, then opts object, then Command
        const opts = actionArgs[actionArgs.length - 2] as Record<
          string,
          string
        >;
        const positionals = actionArgs.slice(
          0,
          actionArgs.length - 2,
        ) as string[];

        const fmt = detectFormat(
          (program.opts().format ?? cmd.defaultFormat) as
            | OutputFormat
            | undefined,
        );

        // Build merged args from positional + option args
        const mergedArgs: Record<string, unknown> = {
          limit: parseInt(opts.limit, 10) || 20,
        };

        // Map positional values
        let posIdx = 0;
        for (const arg of adapterArgs) {
          if (arg.positional && posIdx < positionals.length) {
            mergedArgs[arg.name] = positionals[posIdx++];
          }
        }

        // Map option values
        for (const arg of adapterArgs) {
          if (!arg.positional && opts[arg.name] !== undefined) {
            mergedArgs[arg.name] =
              arg.type === "int"
                ? parseInt(opts[arg.name], 10)
                : opts[arg.name];
          } else if (
            !arg.positional &&
            arg.default !== undefined &&
            mergedArgs[arg.name] === undefined
          ) {
            mergedArgs[arg.name] = arg.default;
          }
        }

        // Override limit from option args if adapter defines it
        if (opts.limit) {
          mergedArgs.limit = parseInt(opts.limit, 10) || 20;
        }

        try {
          let results: unknown[];

          if (cmd.pipeline) {
            // YAML pipeline execution
            results = await runPipeline(cmd.pipeline, mergedArgs, adapter.base);
          } else if (cmd.func) {
            // TypeScript adapter function
            const raw = await cmd.func(null as never, mergedArgs);
            results = Array.isArray(raw) ? raw : [raw];
          } else {
            console.error(
              chalk.red("No pipeline or function defined for this command"),
            );
            process.exit(ExitCode.CONFIG_ERROR);
          }

          if (results.length === 0) {
            if (fmt === "json") {
              console.log("[]");
            } else {
              console.log(chalk.dim("No results"));
            }
            process.exit(ExitCode.EMPTY_RESULT);
          }

          console.log(format(results, cmd.columns, fmt));
        } catch (err) {
          if (err instanceof PipelineError) {
            // Structured error for AI agents — includes adapter path,
            // failing step, and repair suggestion
            const agentError = err.toAgentJSON(
              `src/adapters/${adapter.name}/${cmdName}.yaml`,
            );
            if (fmt === "json" || !process.stdout.isTTY) {
              console.error(JSON.stringify(agentError, null, 2));
            } else {
              console.error(chalk.red(`Error: ${err.message}`));
              console.error(chalk.dim(`  adapter: ${agentError.adapter}`));
              console.error(
                chalk.dim(`  step: ${agentError.step} (${agentError.action})`),
              );
              console.error(
                chalk.yellow(`  suggestion: ${agentError.suggestion}`),
              );
            }
            const exitCode =
              agentError.statusCode === 403 || agentError.statusCode === 401
                ? ExitCode.AUTH_REQUIRED
                : agentError.errorType === "empty_result"
                  ? ExitCode.EMPTY_RESULT
                  : ExitCode.GENERIC_ERROR;
            process.exit(exitCode);
          }

          const message = err instanceof Error ? err.message : String(err);
          if (fmt === "json") {
            console.error(JSON.stringify({ error: message }));
          } else {
            console.error(chalk.red(`Error: ${message}`));
          }
          process.exit(ExitCode.GENERIC_ERROR);
        }
      });
    }
  }

  return program;
}
