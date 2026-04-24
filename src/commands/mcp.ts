/**
 * MCP gateway CLI — wrapper around src/mcp/server.ts.
 *
 *   unicli mcp serve [--transport stdio|http] [--port 19826] [--expanded]
 *   unicli mcp health                       # pre-flight check (no server)
 *
 * `serve` shells out to the same `src/mcp/server.ts` entry point as
 * `npm run mcp` so the two paths share exactly one implementation.
 *
 * `health` is intentionally fast and offline: it loads adapters into the
 * registry and prints a structured health report. Exit 0 if healthy, 1 if not.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllAdapters, loadTsAdapters } from "../discovery/loader.js";
import { getAllAdapters, listCommands } from "../registry.js";
import { VERSION } from "../constants.js";
import { format, detectFormat } from "../output/formatter.js";
import { makeCtx } from "../output/envelope.js";
import { errorTypeToCode, mapErrorToExitCode } from "../output/error-map.js";
import { buildDefaultTools } from "../mcp/tools.js";
import type { OutputFormat } from "../types.js";

interface ServeOptions {
  transport?: "stdio" | "http";
  port?: string;
  expanded?: boolean;
}

interface HealthOptions {
  json?: boolean;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the MCP server entry point. In production (after `npm run build`)
 * the compiled JS lives at `dist/mcp/server.js`; in dev / tests we run the
 * TypeScript source via `npx tsx`. Both work because the file lives in a
 * stable relative position from this commands file.
 */
function resolveServerEntry(): { kind: "ts" | "js"; path: string } {
  const candidateJs = join(__dirname, "..", "mcp", "server.js");
  const candidateTs = join(__dirname, "..", "mcp", "server.ts");
  if (__dirname.includes("/dist/")) {
    return { kind: "js", path: candidateJs };
  }
  return { kind: "ts", path: candidateTs };
}

export function registerMcpCommand(program: Command): void {
  const mcp = program
    .command("mcp")
    .description("MCP (Model Context Protocol) gateway for Uni-CLI");

  mcp
    .command("serve")
    .description(
      "Start the MCP server (stdio default, --transport http for HTTP/JSON-RPC)",
    )
    .option("--transport <kind>", "stdio or http", "stdio")
    .option("--port <n>", "Port for http transport", "19826")
    .option(
      "--expanded",
      "Register one tool per adapter command (full catalog)",
    )
    .action((opts: ServeOptions) => {
      const entry = resolveServerEntry();
      const args: string[] = [entry.path];
      if (opts.expanded) args.push("--expanded");
      if (opts.transport) {
        args.push("--transport", opts.transport);
      }
      if (opts.port) {
        args.push("--port", opts.port);
      }

      const child =
        entry.kind === "ts"
          ? spawn("npx", ["tsx", ...args], {
              stdio: "inherit",
              env: process.env,
            })
          : spawn("node", args, {
              stdio: "inherit",
              env: process.env,
            });

      child.on("exit", (code) => process.exit(code ?? 0));
      child.on("error", (err) => {
        console.error(chalk.red(`Failed to start MCP server: ${err.message}`));
        process.exit(1);
      });
    });

  mcp
    .command("health")
    .description(
      "Pre-flight check — verify adapters load and report tool counts",
    )
    .option("--json", "Output as JSON (alias for -f json)")
    .action(async (opts: HealthOptions) => {
      const startedAt = Date.now();
      const ctx = makeCtx("mcp.health", startedAt);
      const rootFmt = program.opts().format as OutputFormat | undefined;
      const fmt = detectFormat(opts.json ? "json" : rootFmt);

      try {
        // Load adapters into the registry the same way the server does
        loadAllAdapters();
        await loadTsAdapters();

        const adapters = getAllAdapters();
        const commands = listCommands();

        const defaultToolNames = buildDefaultTools().map((tool) => tool.name);
        const defaultToolCount = defaultToolNames.length;
        const expandedToolCount = commands.length + defaultToolCount;

        const data = {
          status: "ok" as const,
          adapters: adapters.length,
          commands: commands.length,
          tools: { default: defaultToolCount, expanded: expandedToolCount },
          version: VERSION,
        };

        ctx.duration_ms = Date.now() - startedAt;
        console.log(format(data, undefined, fmt, ctx));

        if (fmt === "md" && process.stdout.isTTY) {
          console.error(chalk.bold(`\n  unicli MCP health v${VERSION}`));
          console.error(`    status:   ${chalk.green("ok")}`);
          console.error(`    adapters: ${chalk.green(adapters.length)}`);
          console.error(`    commands: ${chalk.green(commands.length)}`);
          console.error(
            `    tools:    ${chalk.green(String(defaultToolCount))} default, ${chalk.green(expandedToolCount)} expanded`,
          );
          console.error(
            chalk.dim(`\n  Default tools: ${defaultToolNames.join(", ")}`),
          );
          console.error(
            chalk.dim(
              "  To start: unicli mcp serve [--expanded] [--transport http]",
            ),
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.error = {
          code: errorTypeToCode(err),
          message,
          suggestion: "Verify adapter files parse: unicli lint",
          retryable: false,
        };
        ctx.duration_ms = Date.now() - startedAt;
        console.error(format(null, undefined, fmt, ctx));
        process.exit(mapErrorToExitCode(err));
      }
    });
}
