/**
 * @owner       src::commands::acp
 * @does        Serves the Agent Client Protocol catalog and command executor over stdio JSON-RPC.
 * @needs       discovery loader, registry, ACP protocol server, constants, network proxy installer
 * @feeds       src/main.ts ACP fast path and src/cli.ts `unicli acp`
 * @breaks      Fatal startup or protocol errors are written to stderr and exit non-zero.
 * @invariants  Adapters load before initialize; stdout contains JSON-RPC frames only; proxy installation precedes execution.
 * @side-effects Loads adapters, installs process-wide fetch routing, reads stdin, writes stdout/stderr, exits the process.
 * @perf        Adapter loading occurs once before the long-lived protocol loop.
 * @concurrency One ACP server owns stdin/stdout for the process lifetime.
 * @test        tests/unit/commands/acp.test.ts, tests/unit/protocol/acp.test.ts
 * @stability   public
 * @since       2026-04-05
 */

import type { Command } from "commander";
import { loadAllAdapters, loadTsAdapters } from "../discovery/loader.js";
import { getAllAdapters, listCommands } from "../registry.js";
import { AcpServer } from "../protocol/acp.js";
import { VERSION } from "../constants.js";
import { installProxyAwareFetch } from "../engine/proxy.js";

interface AcpOptions {
  debug?: boolean;
}

export async function serveAcp(opts: AcpOptions = {}): Promise<void> {
  installProxyAwareFetch();
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
}

export function registerAcpCommand(program: Command): void {
  program
    .command("acp")
    .description(
      "Serve the Agent Client Protocol (JSON-RPC over stdio) for editor agents",
    )
    .option("--debug", "Log method dispatch to stderr")
    .action(async (opts: AcpOptions) => {
      await serveAcp(opts);
    });
}
