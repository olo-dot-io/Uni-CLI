/**
 * CLI entry point — Commander-based routing with dynamic adapter commands.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { loadAllAdapters } from './discovery/loader.js';
import { getAllAdapters, listCommands } from './registry.js';
import { format, detectFormat } from './output/formatter.js';
import { runPipeline } from './engine/yaml-runner.js';
import { ExitCode } from './types.js';
import type { OutputFormat } from './types.js';

export function createCli(): Command {
  const program = new Command();

  program
    .name('unicli')
    .description('CLI IS ALL YOU NEED — Universal CLI for AI agents')
    .version('0.1.0')
    .option('-f, --format <format>', 'output format: table, json, yaml, csv, md')
    .option('-v, --verbose', 'show pipeline debug steps');

  // Load adapters before parsing
  const adapterCount = loadAllAdapters();

  // Register "list" command
  program
    .command('list')
    .description('List all available commands')
    .option('--site <site>', 'filter by site name')
    .option('--type <type>', 'filter by adapter type')
    .action((opts) => {
      let commands = listCommands();

      if (opts.site) {
        commands = commands.filter((c) => c.site.includes(opts.site));
      }
      if (opts.type) {
        commands = commands.filter((c) => c.type === opts.type);
      }

      const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
      const rows = commands.map((c) => ({
        site: c.site,
        command: c.command,
        description: c.description,
        type: c.type,
        auth: c.auth ? '[auth]' : '',
      }));

      console.log(format(rows, ['site', 'command', 'description', 'type', 'auth'], fmt));
    });

  // Register "doctor" command
  program
    .command('doctor')
    .description('Check extension + daemon connectivity')
    .action(() => {
      console.log(chalk.bold('unicli doctor'));
      console.log(`  Adapters loaded: ${chalk.green(adapterCount)}`);
      console.log(`  Sites: ${chalk.green(getAllAdapters().length)}`);
      console.log(`  Node.js: ${chalk.green(process.version)}`);
      console.log(`  Platform: ${chalk.green(process.platform)}`);
    });

  // Dynamic site commands — register a command for each adapter
  for (const adapter of getAllAdapters()) {
    const siteCmd = program
      .command(adapter.name)
      .description(adapter.description ?? `Commands for ${adapter.displayName ?? adapter.name}`);

    for (const [cmdName, cmd] of Object.entries(adapter.commands)) {
      let cmdStr = cmdName;

      // Register positional arguments from adapter definition
      const adapterArgs = cmd.adapterArgs ?? [];
      for (const arg of adapterArgs) {
        if (arg.positional) {
          cmdStr += arg.required ? ` <${arg.name}>` : ` [${arg.name}]`;
        }
      }

      const subCmd = siteCmd
        .command(cmdStr)
        .description(cmd.description ?? '');

      // Register option arguments
      const registeredOpts = new Set<string>();
      subCmd.option('--limit <n>', 'limit results', '20');
      registeredOpts.add('limit');

      for (const arg of adapterArgs) {
        if (!arg.positional && !registeredOpts.has(arg.name)) {
          const flag = `--${arg.name} <value>`;
          const desc = arg.description ?? '';
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
        const opts = actionArgs[actionArgs.length - 2] as Record<string, string>;
        const positionals = actionArgs.slice(0, actionArgs.length - 2) as string[];

        const fmt = detectFormat(
          (program.opts().format ?? cmd.defaultFormat) as OutputFormat | undefined
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
            mergedArgs[arg.name] = arg.type === 'int'
              ? parseInt(opts[arg.name], 10)
              : opts[arg.name];
          } else if (!arg.positional && arg.default !== undefined && mergedArgs[arg.name] === undefined) {
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
            console.error(chalk.red('No pipeline or function defined for this command'));
            process.exit(ExitCode.CONFIG_ERROR);
          }

          if (results.length === 0) {
            if (fmt === 'json') {
              console.log('[]');
            } else {
              console.log(chalk.dim('No results'));
            }
            process.exit(ExitCode.EMPTY_RESULT);
          }

          console.log(format(results, cmd.columns, fmt));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (fmt === 'json') {
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
