/**
 * @owner       src/commands/mcp.ts
 * @does        Register MCP serve/health commands and forward trusted server/browser policy to the canonical MCP process.
 * @needs       commander, child_process, MCP tools, discovery/registry, output envelopes
 * @feeds       src/cli.ts and src/mcp/server.ts
 * @breaks      Invalid server policy fails in the child before binding; spawn and health failures surface nonzero exits.
 * @invariants  Browser provider/visibility/partition are server-owned flags and never untrusted MCP tool arguments.
 * @side-effects Spawns the MCP server or loads adapters and writes a health envelope.
 * @perf        Serve adds one process; health performs one adapter registry load.
 * @concurrency The child owns MCP concurrency; this wrapper forwards immutable startup arguments.
 * @test        tests/unit/commands/mcp.test.ts, tests/unit/mcp-browser-invocation.test.ts
 * @stability   stable
 * @since       2026-04-06
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
  transport?: "stdio" | "http" | "streamable";
  port?: string;
  expanded?: boolean;
  profile?: string;
  auth?: boolean;
  browserProvider?: string;
  browserVisibility?: string;
  browserProfilePartition?: string;
  browserIsolated?: boolean;
  browserEphemeral?: boolean;
  browserProfileId?: string;
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

export function buildMcpServerArgs(
  entryPath: string,
  opts: ServeOptions,
): string[] {
  const args = [entryPath];
  if (opts.expanded) args.push("--expanded");
  if (opts.profile && opts.profile !== "default") {
    args.push("--profile", opts.profile);
  }
  if (opts.transport) args.push("--transport", opts.transport);
  if (opts.port) args.push("--port", opts.port);
  if (opts.auth) args.push("--auth");
  if (opts.browserProvider) {
    args.push("--browser-provider", opts.browserProvider);
  }
  if (opts.browserVisibility) {
    args.push("--browser-visibility", opts.browserVisibility);
  }
  if (opts.browserProfilePartition) {
    args.push("--browser-profile-partition", opts.browserProfilePartition);
  }
  if (opts.browserIsolated) args.push("--browser-isolated");
  if (opts.browserEphemeral) args.push("--browser-ephemeral");
  if (opts.browserProfileId) {
    args.push("--browser-profile-id", opts.browserProfileId);
  }
  return args;
}

export function registerMcpCommand(program: Command): void {
  const mcp = program
    .command("mcp")
    .description("MCP (Model Context Protocol) gateway for Uni-CLI");

  mcp
    .command("serve")
    .description(
      "Start the MCP server with one trusted browser policy for every client call",
    )
    .option("--transport <kind>", "stdio, http, or streamable", "stdio")
    .option("--port <n>", "Port for HTTP transports", "19826")
    .option("--auth", "Enable OAuth for HTTP transports")
    .option(
      "--expanded",
      "Register one tool per adapter command (full catalog)",
    )
    .option(
      "--profile <name>",
      "Tool profile: default, deferred, expanded, or computer-use",
      "default",
    )
    .option(
      "--browser-provider <provider>",
      "Trusted browser provider: managed, chrome, or remote",
      "managed",
    )
    .option(
      "--browser-visibility <mode>",
      "Trusted visibility: hidden, background, or foreground",
    )
    .option(
      "--browser-profile-partition <id>",
      "Shared login/storage partition for MCP Agent sessions",
      "default",
    )
    .option(
      "--browser-isolated",
      "Allocate a fresh target for each MCP tool invocation",
    )
    .option(
      "--browser-ephemeral",
      "Use an empty disposable managed-browser profile",
    )
    .option(
      "--browser-profile-id <id>",
      "Select one managed automation profile",
    )
    .action((opts: ServeOptions) => {
      const entry = resolveServerEntry();
      const args = buildMcpServerArgs(entry.path, opts);

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
        const deferredToolCount = commands.length + defaultToolCount;
        const expandedToolCount = commands.length + defaultToolCount;

        const data = {
          status: "ok" as const,
          adapters: adapters.length,
          commands: commands.length,
          tools: {
            default: defaultToolCount,
            deferred: deferredToolCount,
            expanded: expandedToolCount,
          },
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
            `    tools:    ${chalk.green(String(defaultToolCount))} default, ${chalk.green(deferredToolCount)} deferred, ${chalk.green(expandedToolCount)} expanded`,
          );
          console.error(
            chalk.dim(`\n  Default tools: ${defaultToolNames.join(", ")}`),
          );
          console.error(
            chalk.dim(
              "  To start: unicli mcp serve [--profile deferred] [--transport http]",
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
