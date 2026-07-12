/**
 * @owner       src::engine::repair::plan
 * @does        Defines the bounded, mutation-free verification plan for one adapter command repair.
 * @needs       Validated site/command names, adapter source path, original command arguments
 * @feeds       repair Commander command and manifest fast-path dry run
 * @breaks      Invalid names or arguments throw RepairInputError before any subprocess starts.
 * @invariants  The original command is the oracle; JSON format is forced; repair never edits or commits source.
 * @side-effects None.
 * @perf        O(argument count).
 * @concurrency Pure and reentrant.
 * @test        tests/unit/repair.test.ts, tests/unit/fast-path.test.ts
 * @stability   public CLI contract
 * @since       2026-07-12
 */

const SAFE_NAME = /^[a-z0-9][a-z0-9._-]*$/i;
const MAX_REPAIR_ATTEMPTS = 3;

export class RepairInputError extends Error {
  readonly code = "invalid_input";
}

export interface RepairPlan {
  mode: "verification-plan";
  mutates_source: false;
  target: {
    site: string;
    command: string;
    adapter_path: string;
  };
  oracle: {
    argv: string[];
    timeout_ms: number;
    environment: { UNICLI_FORCE_QUARANTINE: "1" };
    success: { envelope_ok: true; process_exit: 0 };
  };
  repair_budget: {
    max_attempts: number;
    same_error_requires_new_hypothesis: true;
  };
}

function validateName(label: "site" | "command", value: string): void {
  if (!SAFE_NAME.test(value)) {
    throw new RepairInputError(`Invalid ${label} name: ${value}`);
  }
}

export function parseTargetArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new RepairInputError(
      `--target-args must be a JSON array: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((arg) => typeof arg === "string")
  ) {
    throw new RepairInputError("--target-args must be a JSON array of strings");
  }
  const forbidden = parsed.find(
    (arg) =>
      arg === "-f" ||
      arg === "--format" ||
      arg.startsWith("--format=") ||
      arg === "--dry-run",
  );
  if (forbidden) {
    throw new RepairInputError(
      `--target-args cannot contain ${forbidden}; repair owns execution and JSON evidence`,
    );
  }
  return parsed;
}

export function buildRepairPlan(input: {
  site: string;
  command: string;
  adapterPath: string;
  targetArgs?: string[];
  argsFile?: string;
  timeoutMs?: number;
}): RepairPlan {
  validateName("site", input.site);
  validateName("command", input.command);
  if (!input.adapterPath.trim()) {
    throw new RepairInputError(
      "repair target is missing an adapter source path",
    );
  }
  const timeoutMs = input.timeoutMs ?? 90_000;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > 300_000
  ) {
    throw new RepairInputError(
      "repair timeout must be between 1 and 300 seconds",
    );
  }
  const targetArgs = input.targetArgs ?? [];
  const argv = ["unicli", input.site, input.command, ...targetArgs];
  if (input.argsFile) argv.push("--args-file", input.argsFile);
  argv.push("--format", "json");

  return {
    mode: "verification-plan",
    mutates_source: false,
    target: {
      site: input.site,
      command: input.command,
      adapter_path: input.adapterPath,
    },
    oracle: {
      argv,
      timeout_ms: timeoutMs,
      environment: { UNICLI_FORCE_QUARANTINE: "1" },
      success: { envelope_ok: true, process_exit: 0 },
    },
    repair_budget: {
      max_attempts: MAX_REPAIR_ATTEMPTS,
      same_error_requires_new_hypothesis: true,
    },
  };
}
