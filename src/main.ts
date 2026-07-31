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

async function main(): Promise<void> {
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
}

async function emitStartupFailure(error: unknown): Promise<void> {
  const tagged = error as Partial<{
    code: string;
    adapter_path: string;
    suggestion: string;
    retryable: boolean;
    exitCode: number;
  }>;
  const adapterFailure = tagged.code?.startsWith("adapter_") === true;
  const exitCode = tagged.exitCode ?? (adapterFailure ? 78 : 1);
  const { detectFormat, format } = await import("./output/formatter.js");
  const { makeCtx } = await import("./output/envelope.js");
  const requestedFormat = readRequestedFormat(process.argv.slice(2));
  const ctx = makeCtx("core.startup", Date.now());
  ctx.error = {
    code: tagged.code ?? "internal_error",
    message: error instanceof Error ? error.message : String(error),
    ...(tagged.adapter_path ? { adapter_path: tagged.adapter_path } : {}),
    step: 0,
    suggestion:
      tagged.suggestion ??
      (adapterFailure
        ? "Fix the named adapter or run `unicli doctor` to inspect all adapter load failures."
        : "Retry with -f json and inspect the structured startup error."),
    retryable: tagged.retryable ?? false,
    exit_code: exitCode,
  };
  ctx.duration_ms = 0;
  process.exitCode = exitCode;
  console.error(format(null, undefined, detectFormat(requestedFormat), ctx));
}

function readRequestedFormat(
  args: readonly string[],
): "json" | "yaml" | "csv" | "md" | "compact" | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-f" || argument === "--format") {
      const value = args[index + 1];
      if (isOutputFormat(value)) return value;
    }
    if (argument.startsWith("--format=")) {
      const value = argument.slice("--format=".length);
      if (isOutputFormat(value)) return value;
    }
  }
  return undefined;
}

function isOutputFormat(
  value: string | undefined,
): value is "json" | "yaml" | "csv" | "md" | "compact" {
  return (
    value === "json" ||
    value === "yaml" ||
    value === "csv" ||
    value === "md" ||
    value === "compact"
  );
}

try {
  await main();
} catch (error) {
  await emitStartupFailure(error);
}
