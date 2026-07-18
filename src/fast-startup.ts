/**
 * @owner       src::fast-startup
 * @does        Renders the concise root help used before the full command registry loads.
 * @needs       No runtime dependencies.
 * @feeds       src::main root --help/no-argument path
 * @breaks      Stale conceptual groups misdirect discovery, so help names stable meta-surfaces rather than inventory counts.
 * @invariants  Root help is concise, does not enumerate sites, and points to search/list/describe for current inventory truth.
 * @side-effects None; returns text.
 * @perf        Constant time and allocation independent of adapter count.
 * @concurrency Pure and reentrant.
 * @test        tests/unit/fast-startup.test.ts
 * @stability   public
 * @since       2026-07-12
 */

const HELP = `Usage: unicli [options] [command]

Open Agent-Computer Interface runtime for real software.

Discovery:
  search <intent...>            Find commands by bilingual intent
  list [--site <site>]          List current sites and commands
  describe [site] [command]     Show command schema and examples

Execution and recovery:
  <site> <command> [options]    Run a website, app, or local-tool command
  repair [site] [command]      Verify a repair with the original command
  doctor                       Diagnose adapters, browser runtime, and tools

Control surfaces:
  browser                      Broker-owned browser lifecycle and actions
  auth                         Explicit authentication storage and checks
  compute                      Desktop accessibility and visual transports
  mcp                          Model Context Protocol gateway
  acp                          Agent Client Protocol server

Global options:
  -V, --version                Output the version number
  -f, --format <format>        json, yaml, csv, md, or compact
  --dry-run                    Resolve and print an execution plan
  --permission-profile <name>  open, confirm, or locked
  --yes                        Approve a gated operation
  -h, --help                   Show this concise root help

Run "unicli help <command>" for command-specific help.
Run "unicli list" for the live inventory; root help never dumps every site.
`;

export function rootHelp(): string {
  return HELP;
}
