/**
 * Schema command — output JSON Schema for adapter command input/output.
 *
 * Usage:
 *   unicli schema <site> <command>   — Schema for a specific command
 *   unicli schema --all              — Schema for ALL commands
 *
 * Output is always JSON, suitable for machine consumption.
 */

import { Command } from "commander";
import chalk from "chalk";
import { getAllAdapters, resolveCommand } from "../registry.js";
import type { AdapterCommand } from "../types.js";
import { ExitCode } from "../types.js";
import {
  type JsonSchemaObject,
  buildInputSchema,
  buildOutputSchema,
} from "../mcp/schema.js";

// ── Schema output shape ──────────────────────────────────────────────────

interface CommandSchema {
  site: string;
  command: string;
  description: string;
  input: JsonSchemaObject;
  output: JsonSchemaObject;
}

function buildCommandSchema(
  site: string,
  cmdName: string,
  cmd: AdapterCommand,
): CommandSchema {
  return {
    site,
    command: cmdName,
    description: cmd.description ?? "",
    input: buildInputSchema(cmd),
    output: buildOutputSchema(cmd, "flat"),
  };
}

// ── Command registration ─────────────────────────────────────────────────

export function registerSchemaCommand(program: Command): void {
  program
    .command("schema [site] [command]")
    .description("Output JSON Schema for adapter command input/output")
    .option("--all", "output schema for ALL commands")
    .action(
      (
        site: string | undefined,
        command: string | undefined,
        opts: { all?: boolean },
      ) => {
        if (opts.all) {
          // Schema for all commands
          const schemas: CommandSchema[] = [];
          for (const adapter of getAllAdapters()) {
            for (const [cmdName, cmd] of Object.entries(adapter.commands)) {
              schemas.push(buildCommandSchema(adapter.name, cmdName, cmd));
            }
          }

          if (schemas.length === 0) {
            console.error(chalk.red("No adapters loaded"));
            process.exit(ExitCode.GENERIC_ERROR);
          }

          console.log(JSON.stringify(schemas, null, 2));
          return;
        }

        if (!site || !command) {
          console.error(
            chalk.red(
              "Usage: unicli schema <site> <command>  or  unicli schema --all",
            ),
          );
          process.exit(ExitCode.USAGE_ERROR);
        }

        const resolved = resolveCommand(site, command);
        if (!resolved) {
          // Try to suggest similar commands
          const adapters = getAllAdapters();
          const matching = adapters
            .filter((a) => a.name.includes(site))
            .map((a) => ({
              site: a.name,
              commands: Object.keys(a.commands),
            }));

          if (matching.length > 0) {
            console.error(chalk.red(`Unknown command: ${site} ${command}`));
            console.error(
              chalk.dim(
                `Available for matching sites: ${JSON.stringify(matching)}`,
              ),
            );
          } else {
            console.error(chalk.red(`Unknown site: ${site}`));
          }
          process.exit(ExitCode.USAGE_ERROR);
        }

        const schema = buildCommandSchema(site, command, resolved.command);
        console.log(JSON.stringify(schema, null, 2));
      },
    );
}
