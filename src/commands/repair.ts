/**
 * @owner       src::commands::repair
 * @does        Plans or performs one bounded adapter verification without mutating source or git state.
 * @needs       registry resolution, repair plan/verifier/classifier, quarantine discovery, v2 formatter
 * @feeds       `unicli repair`, agent repair skills, structured error next actions
 * @breaks      Unknown targets, malformed args, incomplete quarantine scans, and verifier failures emit error envelopes.
 * @invariants  ok=true iff verification envelope and exit code both succeed; repair never invokes an agent or git.
 * @side-effects Reads adapters; normal mode starts one target subprocess; quarantine mode scans YAML.
 * @perf        One target command with a caller-bounded 1–300 second timeout.
 * @concurrency One verification subprocess per invocation.
 * @test        tests/unit/commands/repair.test.ts, tests/integration/repair-truth.test.ts
 * @stability   public
 * @since       2026-04-07
 */

import type { Command } from "commander";
import { resolveCommand } from "../registry.js";
import { resolveOperationAdapterPath } from "../engine/operation-policy.js";
import { classifyRepairFailure } from "../engine/repair/failure-classifier.js";
import {
  buildRepairPlan,
  parseTargetArgs,
  RepairInputError,
} from "../engine/repair/plan.js";
import { discoverQuarantinedAdapters } from "../engine/repair/quarantine-discovery.js";
import { verifyRepairPlan } from "../engine/repair/verifier.js";
import { format, detectFormat } from "../output/formatter.js";
import {
  makeCtx,
  type AgentContext,
  type AgentError,
  type AgentNextAction,
} from "../output/envelope.js";
import { ExitCode, type OutputFormat } from "../types.js";

interface RepairOptions {
  timeout?: string;
  targetArgs?: string;
  dryRun?: boolean;
  quarantined?: boolean;
}

interface RepairOutput {
  context: AgentContext;
  format: OutputFormat;
  startedAt: number;
}

function emitSuccess(
  output: RepairOutput,
  data: Record<string, unknown>,
): void {
  output.context.duration_ms = Date.now() - output.startedAt;
  console.log(format(data, undefined, output.format, output.context));
  process.exitCode = ExitCode.SUCCESS;
}

function emitFailure(
  output: RepairOutput,
  error: AgentError,
  exitCode: number,
  nextActions: AgentNextAction[] = [],
): void {
  output.context.error = { ...error, exit_code: error.exit_code ?? exitCode };
  output.context.next_actions = nextActions;
  output.context.duration_ms = Date.now() - output.startedAt;
  console.error(format(null, undefined, output.format, output.context));
  process.exitCode = exitCode;
}

function emitQuarantined(output: RepairOutput): void {
  const result = discoverQuarantinedAdapters();
  if (result.parse_errors.length > 0) {
    const first = result.parse_errors[0];
    emitFailure(
      output,
      {
        code: "invalid_input",
        message: `Quarantine scan is incomplete: ${result.parse_errors.length} adapter file(s) could not be parsed; first failure: ${first.message}`,
        adapter_path: first.adapter_path,
        suggestion:
          "Fix every YAML parse error, then rerun the quarantine scan.",
        retryable: false,
        alternatives: ["unicli lint"],
      },
      ExitCode.CONFIG_ERROR,
    );
    return;
  }

  emitSuccess(output, {
    mode: "quarantined-list",
    complete: true,
    count: result.adapters.length,
    adapters: result.adapters.map((adapter) => ({
      site: adapter.site,
      command: adapter.name,
      reason: adapter.reason,
      adapter_path: adapter.adapter_path,
      quarantined_since: adapter.quarantined_since ?? null,
      next_action: `unicli repair ${adapter.site} ${adapter.name}`,
    })),
  });
}

function parseTimeout(value: string | undefined): number {
  const seconds = value === undefined ? 90 : Number(value);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) {
    throw new RepairInputError(
      "--timeout must be an integer from 1 to 300 seconds",
    );
  }
  return seconds * 1_000;
}

function displayOracle(argv: string[]): string {
  return argv
    .map((arg) =>
      /^[a-z0-9_./:=@+-]+$/i.test(arg)
        ? arg
        : `'${arg.replaceAll("'", `'\\''`)}'`,
    )
    .join(" ");
}

function inputFailure(
  output: RepairOutput,
  message: string,
  adapterPath?: string,
): void {
  emitFailure(
    output,
    {
      code: "invalid_input",
      message,
      ...(adapterPath ? { adapter_path: adapterPath } : {}),
      suggestion:
        "Resolve a concrete adapter command with `unicli describe <site> <command>`, then retry.",
      retryable: false,
      alternatives: ["unicli list", "unicli search <intent>"],
    },
    ExitCode.USAGE_ERROR,
  );
}

function executeRepair(
  output: RepairOutput,
  site: string,
  commandName: string,
  opts: RepairOptions,
  argsFile: string | undefined,
): void {
  const resolved = resolveCommand(site, commandName);
  if (!resolved) {
    inputFailure(output, `Unknown adapter command: ${site} ${commandName}`);
    return;
  }
  const adapterPath = resolveOperationAdapterPath(
    site,
    commandName,
    resolved.command.adapter_path,
  );

  let plan;
  try {
    plan = buildRepairPlan({
      site,
      command: commandName,
      adapterPath,
      targetArgs: parseTargetArgs(opts.targetArgs),
      argsFile,
      timeoutMs: parseTimeout(opts.timeout),
    });
  } catch (error) {
    inputFailure(
      output,
      error instanceof Error ? error.message : String(error),
      adapterPath,
    );
    return;
  }

  if (opts.dryRun === true) {
    emitSuccess(output, { ...plan });
    return;
  }
  if (process.env.UNICLI_REPAIR_CHILD === "1") {
    emitFailure(
      output,
      {
        code: "invalid_input",
        message: "Nested repair verification is not allowed",
        adapter_path: adapterPath,
        suggestion:
          "Use the original adapter command as the verification target.",
        retryable: false,
      },
      ExitCode.CONFIG_ERROR,
    );
    return;
  }

  const oracle = displayOracle(plan.oracle.argv);
  const verification = verifyRepairPlan(plan);
  if (verification.status === "passed") {
    output.context.next_actions = [
      {
        command: oracle,
        description: "Run the verified command for the original task",
      },
    ];
    emitSuccess(output, {
      mode: "verification",
      verified: true,
      target: plan.target,
      oracle: {
        command: oracle,
        exit_code: verification.exitCode,
        envelope_ok: verification.envelope.ok,
      },
      evidence: {
        sha256: verification.evidenceSha256,
        duration_ms: verification.envelope.meta.duration_ms,
        count: verification.envelope.meta.count ?? null,
      },
    });
    return;
  }

  if (verification.status === "failed") {
    const targetError = verification.envelope.error;
    const diagnosis = classifyRepairFailure(targetError, {
      site,
      command: commandName,
      adapterPath,
      oracle,
    });
    const commands = [...new Set(diagnosis.nextCommands)];
    emitFailure(
      output,
      {
        ...targetError,
        message: `Verification failed for ${oracle}: ${targetError.message}`,
        adapter_path: targetError.adapter_path ?? adapterPath,
        suggestion: diagnosis.guidance,
        exit_code: verification.exitCode,
        alternatives: commands,
      },
      verification.exitCode,
      commands.map((command) => ({
        command,
        description:
          command === oracle
            ? "Re-run the exact verification oracle"
            : "Follow the bounded diagnostic path",
      })),
    );
    return;
  }

  const isTimeout = verification.code === "timeout";
  emitFailure(
    output,
    {
      code: isTimeout ? "network_error" : "internal_error",
      message: verification.message,
      adapter_path: adapterPath,
      suggestion: isTimeout
        ? "Increase --timeout only if the target normally needs longer; otherwise diagnose the stalled boundary."
        : "Preserve the child output and fix the envelope/exit-code contract before attempting source repair.",
      exit_code: verification.exitCode,
      retryable: isTimeout,
      alternatives: [oracle],
    },
    verification.exitCode,
    [
      {
        command: oracle,
        description:
          "Run the original command directly and inspect its envelope",
      },
    ],
  );
}

export function registerRepairCommand(program: Command): void {
  program
    .command("repair [site] [command]")
    .description("Verify one repaired adapter against its original command")
    .option("--timeout <seconds>", "Verification timeout (1-300)", "90")
    .option(
      "--target-args <json>",
      'Original command argv as a JSON string array, e.g. ["query","--limit","2"]',
    )
    .option("--dry-run", "Show the mutation-free verification plan")
    .option(
      "--quarantined",
      "Enumerate quarantined adapters instead of verifying a target",
    )
    .action(
      (
        site: string | undefined,
        commandName: string | undefined,
        opts: RepairOptions,
      ) => {
        const startedAt = Date.now();
        const programOpts = program.opts<{
          format?: OutputFormat;
          argsFile?: string;
        }>();
        const command = opts.quarantined
          ? "repair.quarantined"
          : opts.dryRun
            ? "repair.plan"
            : "repair.verify";
        const output: RepairOutput = {
          context: makeCtx(command, startedAt),
          format: detectFormat(programOpts.format),
          startedAt,
        };

        if (opts.quarantined === true) {
          emitQuarantined(output);
          return;
        }
        if (!site || !commandName) {
          inputFailure(
            output,
            "repair requires both <site> and <command> unless --quarantined is used",
          );
          return;
        }
        executeRepair(output, site, commandName, opts, programOpts.argsFile);
      },
    );
}
