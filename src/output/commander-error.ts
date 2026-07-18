/**
 * @owner       src::output::commander-error
 * @does        Converts Commander parser control flow into the stable Uni-CLI error envelope contract.
 * @needs       commander, error writer, output format detection, CLI exit codes
 * @feeds       src/cli.ts and src/main.ts
 * @breaks      Commander messages can contain raw user tokens and Commander defaults to a non-contract exit status.
 * @invariants  Parser diagnostics never emit Commander message text; every parser failure records invalid_input with the usage exit code.
 * @side-effects Suppresses Commander's stderr writer, installs its throw boundary, writes one structured error envelope.
 * @perf        Constant-time mapping over Commander's bounded error code.
 * @concurrency One configured Commander tree per CLI process.
 * @test        tests/unit/cli/commander-error-cli.test.ts
 * @stability   internal
 * @since       2026-07-18
 */

import { Command, CommanderError } from "commander";
import { ExitCode, type OutputFormat } from "../types.js";
import { detectFormat } from "./formatter.js";
import { printErrorEnvelope } from "./error-writer.js";

interface SafeCommanderDiagnostic {
  message: string;
  suggestion: string;
}

const diagnostics: Readonly<Record<string, SafeCommanderDiagnostic>> = {
  "commander.unknownOption": {
    message: "unknown CLI option",
    suggestion: "run `unicli --help` to inspect supported options",
  },
  "commander.optionMissingArgument": {
    message: "CLI option value is required",
    suggestion: "run `unicli --help` to inspect option value requirements",
  },
  "commander.missingMandatoryOptionValue": {
    message: "required CLI option is missing",
    suggestion: "run the command with `--help` to inspect required options",
  },
  "commander.missingArgument": {
    message: "required CLI argument is missing",
    suggestion: "run the command with `--help` to inspect required arguments",
  },
  "commander.excessArguments": {
    message: "too many CLI arguments",
    suggestion: "run the command with `--help` to inspect accepted arguments",
  },
  "commander.conflictingOption": {
    message: "CLI options conflict",
    suggestion: "run the command with `--help` to inspect compatible options",
  },
  "commander.invalidArgument": {
    message: "invalid CLI argument",
    suggestion: "run the command with `--help` to inspect accepted values",
  },
};

const fallbackDiagnostic: SafeCommanderDiagnostic = {
  message: "invalid CLI invocation",
  suggestion: "run `unicli --help` or `unicli search <intent>`",
};

export function installCommanderErrorBoundary(program: Command): void {
  program.configureOutput({ writeErr: () => undefined });
  program.exitOverride();
}

export function handleCommanderError(
  program: Command,
  error: unknown,
): boolean {
  if (!(error instanceof CommanderError)) return false;
  if (error.exitCode === ExitCode.SUCCESS) return true;

  const diagnostic = diagnostics[error.code] ?? fallbackDiagnostic;
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
  printErrorEnvelope({
    fmt,
    exitCode: ExitCode.USAGE_ERROR,
    ctx: {
      command: "core.unknown",
      duration_ms: 0,
      surface: "system",
      error: {
        code: "invalid_input",
        message: diagnostic.message,
        suggestion: diagnostic.suggestion,
        exit_code: ExitCode.USAGE_ERROR,
        retryable: false,
        alternatives: ["unicli --help", "unicli search <intent>"],
      },
    },
  });
  return true;
}
