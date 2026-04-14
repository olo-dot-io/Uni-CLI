/**
 * `unicli acp` — expose the ACP (Agent Client Protocol) JSON-RPC server
 * on stdio. Designed for avante.nvim and Zed-style editor integrations.
 *
 * Usage:
 *   unicli acp [--debug]
 *
 * On startup we load all adapters (same code path as the main CLI) and
 * then hand control to `AcpServer.startStdio()`. Logs go to stderr;
 * stdout is reserved for JSON-RPC frames.
 */

import type { Command } from "commander";
import { loadAllAdapters, loadTsAdapters } from "../discovery/loader.js";
import { getAllAdapters, listCommands } from "../registry.js";
import { AcpServer } from "../protocol/acp.js";
import { VERSION } from "../constants.js";

interface AcpOptions {
  debug?: boolean;
}

export function registerAcpCommand(program: Command): void {
  program
    .command("acp")
    .description(
      "Serve the Agent Client Protocol (JSON-RPC over stdio) for editor agents",
    )
    .option("--debug", "Log method dispatch to stderr")
    .action(async (opts: AcpOptions) => {
      // Load adapters before entering the serve loop — ACP clients expect
      // `initialize` to respond with a fully-populated catalog.
      loadAllAdapters();
      await loadTsAdapters();

      const adapters = getAllAdapters().length;
      const commands = listCommands().length;

      process.stderr.write(
        `unicli ACP server v${VERSION} — ${adapters} sites, ${commands} commands (stdio)\n`,
      );

      const server = new AcpServer({ debug: opts.debug === true });
      try {
        await server.startStdio();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`acp: fatal: ${message}\n`);
        process.exit(1);
      }
      process.exit(0);
    });
}
