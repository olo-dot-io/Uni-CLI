/**
 * Schema command — output JSON Schema for adapter command input/output.
 *
 * Usage:
 *   unicli schema <site> <command>   — Schema for a specific command
 *   unicli schema --all              — Schema for ALL commands
 *
 * Output is wrapped in the v2 AgentEnvelope — `data.schemas` is the array
 * (or single object) of JSON Schema definitions for the requested surface.
 */

import { Command } from "commander";
import chalk from "chalk";
import { getAllAdapters, resolveCommand } from "../registry.js";
import type { AdapterCommand, OutputFormat } from "../types.js";
import { ExitCode } from "../types.js";
import {
  type JsonSchemaObject,
  buildInputSchema,
  buildOutputSchema,
} from "../mcp/schema.js";
import { format, detectFormat } from "../output/formatter.js";
import { makeCtx } from "../output/envelope.js";

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
        const startedAt = Date.now();
        const subcommand = opts.all ? "dump" : "describe";
        const ctx = makeCtx(`schema.${subcommand}`, startedAt);
        const fmt = detectFormat(
          program.opts().format as OutputFormat | undefined,
        );

        if (opts.all) {
          // Schema for all commands
          const schemas: CommandSchema[] = [];
          for (const adapter of getAllAdapters()) {
            for (const [cmdName, cmd] of Object.entries(adapter.commands)) {
              schemas.push(buildCommandSchema(adapter.name, cmdName, cmd));
            }
          }

          if (schemas.length === 0) {
            ctx.error = {
              code: "not_found",
              message: "No adapters loaded",
              suggestion: "Run `unicli list` to check adapter discovery.",
              retryable: false,
            };
            ctx.duration_ms = Date.now() - startedAt;
            console.error(format(null, undefined, fmt, ctx));
            process.exit(ExitCode.GENERIC_ERROR);
          }

          ctx.duration_ms = Date.now() - startedAt;
          console.log(format(schemas, undefined, fmt, ctx));
          console.error(
            chalk.dim(
              `\n  ${schemas.length} command schema(s) across ${getAllAdapters().length} site(s)`,
            ),
          );
          return;
        }

        if (!site || !command) {
          ctx.error = {
            code: "invalid_input",
            message:
              "Usage: unicli schema <site> <command>  or  unicli schema --all",
            suggestion: "Pass both a site and a command, or use --all.",
            retryable: false,
          };
          ctx.duration_ms = Date.now() - startedAt;
          console.error(format(null, undefined, fmt, ctx));
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

          ctx.error = {
            code: "not_found",
            message:
              matching.length > 0
                ? `Unknown command: ${site} ${command}`
                : `Unknown site: ${site}`,
            suggestion:
              matching.length > 0
                ? `Available for matching sites: ${JSON.stringify(matching)}`
                : "Run `unicli list` to see available sites.",
            retryable: false,
            alternatives:
              matching.length > 0
                ? matching.flatMap((m) =>
                    m.commands.map((c) => `${m.site}.${c}`),
                  )
                : [],
          };
          ctx.duration_ms = Date.now() - startedAt;
          console.error(format(null, undefined, fmt, ctx));
          process.exit(ExitCode.USAGE_ERROR);
        }

        const schema = buildCommandSchema(site, command, resolved.command);

        ctx.duration_ms = Date.now() - startedAt;
        console.log(
          format(
            schema as unknown as Record<string, unknown>,
            undefined,
            fmt,
            ctx,
          ),
        );
      },
    );
}
