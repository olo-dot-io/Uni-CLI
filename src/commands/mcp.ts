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
    .option("--json", "Output as JSON (default when piped)")
    .action(async (opts: HealthOptions) => {
      const useJson = opts.json || !process.stdout.isTTY;

      try {
        // Load adapters into the registry the same way the server does
        loadAllAdapters();
        await loadTsAdapters();

        const adapters = getAllAdapters();
        const commands = listCommands();

        // Count expanded tools (1 per command + 3 default)
        let expandedToolCount = 3; // unicli_run, unicli_list, unicli_discover
        for (const adapter of adapters) {
          expandedToolCount += Object.keys(adapter.commands).length;
        }

        const health = {
          status: "ok" as const,
          adapters: adapters.length,
          commands: commands.length,
          tools: { default: 3, expanded: expandedToolCount },
          version: VERSION,
        };

        if (useJson) {
          console.log(JSON.stringify(health, null, 2));
          return;
        }

        console.log(chalk.bold(`unicli MCP health v${VERSION}`));
        console.log(`  status:   ${chalk.green("ok")}`);
        console.log(`  adapters: ${chalk.green(adapters.length)}`);
        console.log(`  commands: ${chalk.green(commands.length)}`);
        console.log(
          `  tools:    ${chalk.green("3")} default, ${chalk.green(expandedToolCount)} expanded`,
        );
        console.log();
        console.log(
          chalk.dim("Default tools: unicli_run, unicli_list, unicli_discover"),
        );
        console.log(
          chalk.dim(
            "To start: unicli mcp serve [--expanded] [--transport http]",
          ),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (useJson) {
          console.log(
            JSON.stringify(
              { status: "error", error: message, version: VERSION },
              null,
              2,
            ),
          );
        } else {
          console.error(chalk.red(`Health check failed: ${message}`));
        }
        process.exit(1);
      }
    });
}
