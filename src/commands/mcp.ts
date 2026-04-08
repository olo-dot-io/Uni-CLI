/**
 * MCP gateway CLI — wrapper around src/mcp/server.ts.
 *
 *   unicli mcp serve [--transport stdio|http] [--port 19826] [--lazy]
 *   unicli mcp health                       # list registered tools (no server)
 *
 * `serve` shells out to the same `src/mcp/server.ts` entry point as
 * `npm run mcp` so the two paths share exactly one implementation.
 *
 * `health` is intentionally fast and offline: it loads adapters into the
 * registry and prints the same tool list the server would build, without
 * binding stdio or HTTP. Useful as a Claude Desktop / Cursor pre-flight.
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
  lazy?: boolean;
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
  // After build: __dirname is dist/commands → ../mcp/server.js
  // In dev (tsx): __dirname is src/commands  → ../mcp/server.ts
  const candidateJs = join(__dirname, "..", "mcp", "server.js");
  const candidateTs = join(__dirname, "..", "mcp", "server.ts");
  // Prefer TS if it exists (dev mode); otherwise JS.
  // We can't easily statSync here without importing fs, but join + spawn will
  // surface the error if neither exists. Use TS by default in dev.
  // The simpler heuristic: if __dirname contains "/dist/", we're built.
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
    .option("--lazy", "Register only list_adapters + run_command (compat mode)")
    .action((opts: ServeOptions) => {
      const entry = resolveServerEntry();
      const args: string[] = [];
      if (entry.kind === "ts") args.unshift(entry.path);
      else args.unshift(entry.path);
      if (opts.lazy) args.push("--lazy");
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
    .description("Pre-flight check — list tools the MCP server would expose")
    .option("--json", "Output as JSON")
    .action(async (opts: HealthOptions) => {
      // Load adapters into the registry the same way the server does
      loadAllAdapters();
      await loadTsAdapters();

      const adapters = getAllAdapters();
      const commands = listCommands();
      const tools: Array<{ name: string; description: string }> = [
        {
          name: "list_adapters",
          description: "List all Uni-CLI adapters and their commands",
        },
      ];
      for (const adapter of adapters) {
        for (const [cmdName, cmd] of Object.entries(adapter.commands)) {
          const toolName = `unicli_${adapter.name}_${cmdName}`.replace(
            /[^a-zA-Z0-9_]/g,
            "_",
          );
          tools.push({
            name: toolName,
            description:
              cmd.description?.trim() ||
              adapter.description?.trim() ||
              `${cmdName} for ${adapter.name}`,
          });
        }
      }

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              version: VERSION,
              sites: adapters.length,
              commands: commands.length,
              tools: tools.length,
              entries: tools,
            },
            null,
            2,
          ),
        );
        return;
      }

      console.log(chalk.bold(`unicli MCP gateway v${VERSION}`));
      console.log(`  sites:    ${chalk.green(adapters.length)}`);
      console.log(`  commands: ${chalk.green(commands.length)}`);
      console.log(
        `  tools:    ${chalk.green(tools.length)} (1 core + ${commands.length} per-command)`,
      );
      console.log();
      console.log(chalk.dim("Sample tools:"));
      for (const t of tools.slice(0, 8)) {
        console.log(`  ${chalk.cyan(t.name)}: ${t.description.slice(0, 60)}`);
      }
      if (tools.length > 8) {
        console.log(chalk.dim(`  … and ${tools.length - 8} more`));
      }
      console.log();
      console.log(chalk.dim("To start: unicli mcp serve [--transport http]"));
    });
}
