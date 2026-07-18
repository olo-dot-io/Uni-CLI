#!/usr/bin/env node

/**
 * @owner       src::main
 * @does        Selects constant-time root version/help, ACP, manifest fast paths, or the full Commander command tree.
 * @needs       constants/fast-startup, ACP server, manifest fast path, full CLI and Commander error boundary loaded only at the owning boundary
 * @feeds       npm `unicli` executable
 * @breaks      Startup routing and command failures propagate their owning exit status.
 * @invariants  Root version/help never load adapters or start network work; only one dispatch path runs.
 * @side-effects Writes CLI output and may load the requested execution substrate.
 * @perf        Root metadata paths import only small constant modules; discovery uses the manifest fast path.
 * @concurrency One top-level dispatch per process.
 * @test        tests/unit/fast-startup.test.ts and CLI integration suites
 * @stability   public
 * @since       2026-04-01
 */

const args = process.argv.slice(2);
const versionFastPath =
  args.length === 1 && (args[0] === "--version" || args[0] === "-V");
const helpFastPath =
  args.length === 0 ||
  (args.length === 1 &&
    (args[0] === "--help" || args[0] === "-h" || args[0] === "help"));
const acpFastPath =
  args[0] === "acp" && args.slice(1).every((arg) => arg === "--debug");

if (versionFastPath) {
  const { VERSION } = await import("./constants.js");
  process.stdout.write(`${VERSION}\n`);
} else if (helpFastPath) {
  const { rootHelp } = await import("./fast-startup.js");
  process.stdout.write(rootHelp());
} else if (acpFastPath) {
  const { serveAcp } = await import("./commands/acp.js");
  await serveAcp({ debug: args.includes("--debug") });
} else {
  const { beginCliInvocationLogging } =
    await import("./runtime/cli-invocation-log.js");
  beginCliInvocationLogging();
  const { tryRunFastPath } = await import("./fast-path.js");
  if (!tryRunFastPath(process.argv)) {
    const { createCli, handleCommanderError } = await import("./cli.js");
    const program = await createCli();
    try {
      program.parse(process.argv);
    } catch (error) {
      if (!handleCommanderError(program, error)) throw error;
    }
  }
}
