/**
 * @owner   src/commands/delivery.ts
 * @does    Exposes the objective-level delivery kernel as a conservative operator CLI.
 * @needs   commander, src/engine/delivery/*, src/engine/session/store.ts, src/output/formatter.ts
 * @feeds   src/cli.ts, tests/unit/delivery-cli.test.ts, future delivery operator workflows.
 * @breaks  Invalid spec parsing or unbounded repair candidates can mislead agents about delivery state.
 * @invariants specs are explicit files; existing run traces remain the source of prior evidence; delivery.run records only through the run store.
 * @side-effects reads spec files and run traces; delivery.run writes one recorded run trace; writes stdout/stderr and process.exitCode.
 * @perf    O(spec attempts + referenced run events).
 * @concurrency no shared mutable state beyond process.exitCode on command errors.
 * @test    tests/unit/delivery-cli.test.ts
 * @stability experimental
 * @since   2026-05-24
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { resolveCommand } from "../registry.js";
import { resolveArgs } from "../engine/args.js";
import { buildInvocation } from "../engine/kernel/execute.js";
import { executeWithRunRecording } from "../engine/session/run-loop.js";
import { detectFormat, format } from "../output/formatter.js";
import { makeCtx, type AgentError } from "../output/envelope.js";
import { printErrorEnvelope } from "../output/error-writer.js";
import { ExitCode, type OutputFormat } from "../types.js";
import {
  assessDeliveryState,
  buildDeliveryTrajectory,
  deliveryAttemptFromRunEvents,
  deliveryRepairCandidateFromTrajectory,
  type DeliveryAttempt,
  type DeliveryAttemptBudget,
  type DeliveryEvidenceGate,
  type DeliveryObjective,
  type DeliveryStateInput,
  type DeliveryStrategy,
  type DeliveryStrategyKind,
  type DeliveryTrajectory,
  type DeliveryTrajectoryInput,
} from "../engine/delivery/index.js";
import {
  createRunStore,
  readRunEvents,
  runTracePath,
  RunStoreError,
} from "../engine/session/store.js";
import type { RunSummary, RunTraceStatus } from "../engine/session/query.js";
import type { RunId } from "../engine/session/types.js";

interface DeliveryCommandOptions {
  root?: string;
  recordedAt?: string;
  runId?: string;
  permissionProfile?: string;
  yes?: boolean;
}

interface DeliveryOperatorSpec {
  objective: DeliveryObjective;
  strategies: DeliveryStrategy[];
  attempts: DeliveryAttempt[];
  runs: DeliveryRunRef[];
  recorded_at?: string;
}

interface DeliveryRunRef {
  run_id: RunId;
  strategy_id: string;
  id?: string;
  ordinal?: number;
}

class DeliveryCliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly suggestion?: string,
  ) {
    super(message);
    this.name = "DeliveryCliError";
  }
}

function fmt(program: Command): OutputFormat {
  return detectFormat(program.opts().format as OutputFormat | undefined);
}

export function registerDeliveryCommand(program: Command): void {
  const delivery = program
    .command("delivery")
    .description(
      "Plan objective delivery from run evidence and repair signals",
    );

  delivery
    .command("run <spec>")
    .description("Execute the next delivery experiment and record its attempt")
    .option("--root <path>", "Override run trace root")
    .option("--run-id <run_id>", "Override the recorded run id")
    .option(
      "--permission-profile <profile>",
      "Override next experiment permission profile",
    )
    .option("--yes", "Approve permission-gated next experiment execution")
    .option("--recorded-at <iso>", "Override returned trajectory recorded_at")
    .action(async (specPath: string, opts: DeliveryCommandOptions) => {
      const startedAt = Date.now();
      try {
        emitDelivery(program, "delivery.run", startedAt, {
          ...(await runNextDeliveryExperimentFromSpec(specPath, opts)),
        });
      } catch (err) {
        emitDeliveryError(program, "delivery.run", startedAt, err);
      }
    });

  delivery
    .command("assess <spec>")
    .description("Assess an objective delivery spec and choose the next action")
    .option("--root <path>", "Override run trace root for spec runs")
    .action(async (specPath: string, opts: DeliveryCommandOptions) => {
      const startedAt = Date.now();
      try {
        const input = await deliveryStateInputFromSpec(specPath, opts);
        emitDelivery(program, "delivery.assess", startedAt, {
          assessment: assessDeliveryState(input),
        });
      } catch (err) {
        emitDeliveryError(program, "delivery.assess", startedAt, err);
      }
    });

  delivery
    .command("trajectory <spec>")
    .description("Build a reviewable delivery trajectory from a spec")
    .option("--root <path>", "Override run trace root for spec runs")
    .option("--recorded-at <iso>", "Override trajectory recorded_at")
    .action(async (specPath: string, opts: DeliveryCommandOptions) => {
      const startedAt = Date.now();
      try {
        emitDelivery(program, "delivery.trajectory", startedAt, {
          ...(await deliveryTrajectoryFromSpec(specPath, opts)),
        });
      } catch (err) {
        emitDeliveryError(program, "delivery.trajectory", startedAt, err);
      }
    });

  delivery
    .command("repair-candidate <spec>")
    .description(
      "Compile a trajectory into one bounded adapter repair candidate",
    )
    .option("--root <path>", "Override run trace root for spec runs")
    .option("--recorded-at <iso>", "Override trajectory recorded_at")
    .action(async (specPath: string, opts: DeliveryCommandOptions) => {
      const startedAt = Date.now();
      try {
        const trajectory = await deliveryTrajectoryFromSpec(specPath, opts);
        const candidate = deliveryRepairCandidateFromTrajectory(trajectory);
        emitDelivery(program, "delivery.repair-candidate", startedAt, {
          objective_id: trajectory.objective_id,
          verification_status: trajectory.verification_status,
          assessment_status: trajectory.assessment.status,
          candidate: candidate ?? null,
        });
      } catch (err) {
        emitDeliveryError(program, "delivery.repair-candidate", startedAt, err);
      }
    });
}

async function runNextDeliveryExperimentFromSpec(
  specPath: string,
  opts: DeliveryCommandOptions,
): Promise<Record<string, unknown>> {
  const spec = await readDeliveryOperatorSpec(specPath);
  const attempts = await attemptsFromSpec(spec, opts.root);
  const trajectory = buildDeliveryTrajectory({
    objective: spec.objective,
    strategies: spec.strategies,
    attempts,
    recorded_at: opts.recordedAt ?? spec.recorded_at,
  });
  const nextExperiment = trajectory.next_experiment;
  if (!nextExperiment) {
    throw new DeliveryCliError(
      "invalid_input",
      `delivery trajectory is not executable: ${trajectory.verification_status}`,
      "inspect `delivery trajectory` and resolve blocked, verified, exhausted, or repair-only state first",
    );
  }
  if (
    nextExperiment.action !== "run_strategy" &&
    nextExperiment.action !== "retry_strategy" &&
    nextExperiment.action !== "switch_strategy"
  ) {
    throw new DeliveryCliError(
      "invalid_input",
      `delivery next action is not directly executable: ${nextExperiment.action}`,
      "use `delivery repair-candidate` for adapter repairs or resolve auth/permission blocks first",
    );
  }
  const strategy = spec.strategies.find(
    (entry) => entry.id === nextExperiment.strategy_id,
  );
  if (!strategy || !strategy.command) {
    throw new DeliveryCliError(
      "invalid_input",
      `strategy has no executable command: ${nextExperiment.strategy_id}`,
      "add `command: site.command` to the selected strategy",
    );
  }
  const parsedCommand = parseStrategyCommand(strategy.command);
  const resolved = resolveCommand(parsedCommand.site, parsedCommand.command);
  if (!resolved) {
    throw new DeliveryCliError(
      "invalid_input",
      `command is not registered: ${strategy.command}`,
      "run `unicli list` and choose a currently registered command",
    );
  }
  const resolvedArgs = resolveArgs({
    opts: strategy.args ?? {},
    positionals: [],
    schema: resolved.command.adapterArgs ?? [],
    stdinIsTTY: true,
  });
  const invocation = buildInvocation(
    "cli",
    parsedCommand.site,
    parsedCommand.command,
    resolvedArgs,
    {
      permissionProfile: opts.permissionProfile,
      approved: opts.yes === true,
    },
  );
  if (!invocation) {
    throw new DeliveryCliError(
      "invalid_input",
      `command is not registered: ${strategy.command}`,
      "run `unicli list` and choose a currently registered command",
    );
  }

  const store = createRunStore({ rootDir: opts.root });
  const runId = opts.runId ?? `run-delivery-${invocation.trace_id}`;
  let tracePath: string;
  try {
    tracePath = runTracePath(store, runId);
  } catch (err) {
    if (err instanceof RunStoreError && err.code === "invalid_run_id") {
      throw new DeliveryCliError(
        "invalid_input",
        err.message,
        "use letters, numbers, dot, underscore, or dash in --run-id",
      );
    }
    throw err;
  }
  if (existsSync(tracePath)) {
    throw new DeliveryCliError(
      "invalid_input",
      `run id already exists: ${runId}`,
      "omit --run-id or choose a new run id",
    );
  }

  const result = await executeWithRunRecording(invocation, {
    enabled: true,
    store,
    runId,
  });
  const runEvents = await readRunEvents(store, runId);
  const newAttempt = deliveryAttemptFromRunEvents({
    id: `attempt-${attempts.length + 1}`,
    ordinal: attempts.length + 1,
    strategy_id: strategy.id,
    run_id: runId,
    events: runEvents,
  });
  const nextTrajectory = buildDeliveryTrajectory({
    objective: spec.objective,
    strategies: spec.strategies,
    attempts: [...attempts, newAttempt],
    recorded_at: opts.recordedAt ?? spec.recorded_at,
  });
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
  return {
    objective_id: spec.objective.id,
    run_id: runId,
    strategy_id: strategy.id,
    next_action: nextExperiment.action,
    result: {
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
      result_count: result.results.length,
      error: result.error ?? null,
      warnings: result.warnings,
    },
    trajectory: nextTrajectory,
  };
}

async function deliveryTrajectoryFromSpec(
  specPath: string,
  opts: DeliveryCommandOptions,
): Promise<DeliveryTrajectory> {
  const spec = await readDeliveryOperatorSpec(specPath);
  const attempts = await attemptsFromSpec(spec, opts.root);
  const input: DeliveryTrajectoryInput = {
    objective: spec.objective,
    strategies: spec.strategies,
    attempts,
    recorded_at: opts.recordedAt ?? spec.recorded_at,
  };
  return buildDeliveryTrajectory(input);
}

async function deliveryStateInputFromSpec(
  specPath: string,
  opts: DeliveryCommandOptions,
): Promise<DeliveryStateInput> {
  const spec = await readDeliveryOperatorSpec(specPath);
  return {
    objective: spec.objective,
    strategies: spec.strategies,
    attempts: await attemptsFromSpec(spec, opts.root),
  };
}

async function attemptsFromSpec(
  spec: DeliveryOperatorSpec,
  root: string | undefined,
): Promise<DeliveryAttempt[]> {
  const attempts = [...spec.attempts];
  const baseAttemptCount = attempts.length;
  const store = createRunStore({ rootDir: root });
  for (const [index, runRef] of spec.runs.entries()) {
    const events = await readRunEvents(store, runRef.run_id);
    if (events.length === 0) {
      throw new DeliveryCliError(
        "invalid_input",
        `run trace not found or empty: ${runRef.run_id}`,
        "run the objective command with --record or choose an existing run id from `unicli runs list`",
      );
    }
    attempts.push(
      deliveryAttemptFromRunEvents({
        id: runRef.id ?? `attempt-${baseAttemptCount + index + 1}`,
        ordinal: runRef.ordinal ?? baseAttemptCount + index + 1,
        strategy_id: runRef.strategy_id,
        run_id: runRef.run_id,
        events,
      }),
    );
  }
  return attempts;
}

async function readDeliveryOperatorSpec(
  specPath: string,
): Promise<DeliveryOperatorSpec> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(specPath, "utf-8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DeliveryCliError(
      "invalid_input",
      `failed to read delivery spec: ${message}`,
      "pass a JSON file with objective, strategies, and optional attempts or runs",
    );
  }
  return parseDeliveryOperatorSpec(parsed);
}

function parseDeliveryOperatorSpec(value: unknown): DeliveryOperatorSpec {
  const record = asRecord(value, "delivery spec");
  const objective = parseObjective(record.objective);
  const strategiesValue = record.strategies;
  if (!Array.isArray(strategiesValue) || strategiesValue.length === 0) {
    throw new DeliveryCliError(
      "invalid_input",
      "delivery spec requires at least one strategy",
      "add `strategies: [{ id, kind, label, priority }]` to the spec",
    );
  }
  const strategies = strategiesValue.map(parseStrategy);
  const attempts = arrayOrEmpty(record.attempts, "attempts").map(parseAttempt);
  const runs = arrayOrEmpty(record.runs, "runs").map(parseRunRef);
  validateStrategyReferences(strategies, attempts, runs);
  return {
    objective,
    strategies,
    attempts,
    runs,
    ...(typeof record.recorded_at === "string"
      ? { recorded_at: record.recorded_at }
      : {}),
  };
}

function parseObjective(value: unknown): DeliveryObjective {
  const record = asRecord(value, "objective");
  const id = requiredString(record.id, "objective.id");
  const goal = requiredString(record.goal, "objective.goal");
  return {
    id,
    goal,
    ...(record.evidence_gates !== undefined
      ? {
          evidence_gates: arrayOrEmpty(
            record.evidence_gates,
            "objective.evidence_gates",
          ).map(parseEvidenceGate),
        }
      : {}),
    ...(record.attempt_budget !== undefined
      ? { attempt_budget: parseAttemptBudget(record.attempt_budget) }
      : {}),
  };
}

function parseStrategy(value: unknown): DeliveryStrategy {
  const record = asRecord(value, "strategy");
  const kind = requiredString(record.kind, "strategy.kind");
  if (!isDeliveryStrategyKind(kind)) {
    throw new DeliveryCliError(
      "invalid_input",
      `invalid strategy.kind: ${kind}`,
      "use adapter, browser, desktop, local, mcp, or manual",
    );
  }
  return {
    id: requiredString(record.id, "strategy.id"),
    kind,
    label: requiredString(record.label, "strategy.label"),
    priority: requiredNumber(record.priority, "strategy.priority"),
    ...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {}),
    ...(typeof record.command === "string" ? { command: record.command } : {}),
    ...(record.args !== undefined
      ? { args: plainRecord(record.args, "strategy.args") }
      : {}),
    ...(typeof record.adapter_path === "string"
      ? { adapter_path: record.adapter_path }
      : {}),
    ...(typeof record.verify_command === "string"
      ? { verify_command: record.verify_command }
      : {}),
  };
}

function parseStrategyCommand(command: string): {
  site: string;
  command: string;
} {
  const trimmed = command.trim();
  const dotIndex = trimmed.indexOf(".");
  if (dotIndex > 0 && dotIndex < trimmed.length - 1) {
    return {
      site: trimmed.slice(0, dotIndex),
      command: trimmed.slice(dotIndex + 1),
    };
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 2) {
    return { site: parts[0], command: parts[1] };
  }
  throw new DeliveryCliError(
    "invalid_input",
    `strategy.command must be "site.command" or "site command": ${command}`,
    "use a command from `unicli list`, for example `github.search`",
  );
}

function parseAttempt(value: unknown): DeliveryAttempt {
  const record = asRecord(value, "attempt");
  return {
    id: requiredString(record.id, "attempt.id"),
    ordinal: requiredNumber(record.ordinal, "attempt.ordinal"),
    strategy_id: requiredString(record.strategy_id, "attempt.strategy_id"),
    run_id: requiredString(record.run_id, "attempt.run_id"),
    summary: parseRunSummary(record.summary),
    ...(record.error !== undefined
      ? { error: parseAgentError(record.error) }
      : {}),
  };
}

function parseRunSummary(value: unknown): RunSummary {
  const record = asRecord(value, "attempt.summary");
  const status = requiredString(record.status, "attempt.summary.status");
  if (!isRunTraceStatus(status)) {
    throw new DeliveryCliError(
      "invalid_input",
      `invalid attempt.summary.status: ${status}`,
      "use completed, failed, running, empty, or unreadable",
    );
  }
  return {
    run_id: requiredString(record.run_id, "attempt.summary.run_id"),
    status,
    events: requiredNumber(record.events, "attempt.summary.events"),
    evidence_count: requiredNumber(
      record.evidence_count,
      "attempt.summary.evidence_count",
    ),
    evidence_by_type: numberRecord(
      record.evidence_by_type,
      "attempt.summary.evidence_by_type",
    ),
    ...(typeof record.command === "string" ? { command: record.command } : {}),
    ...(typeof record.runtime_permission_denied === "object" &&
    record.runtime_permission_denied !== null
      ? {
          runtime_permission_denied: parseRuntimePermissionDenied(
            record.runtime_permission_denied,
          ),
        }
      : {}),
  };
}

function parseRunRef(value: unknown): DeliveryRunRef {
  const record = asRecord(value, "runs[]");
  if (record.ordinal !== undefined) {
    requiredNumber(record.ordinal, "runs[].ordinal");
  }
  return {
    run_id: requiredString(record.run_id, "runs[].run_id"),
    strategy_id: requiredString(record.strategy_id, "runs[].strategy_id"),
    ...(typeof record.id === "string" ? { id: record.id } : {}),
    ...(typeof record.ordinal === "number" && Number.isFinite(record.ordinal)
      ? { ordinal: record.ordinal }
      : {}),
  };
}

function parseEvidenceGate(value: unknown): DeliveryEvidenceGate {
  const record = asRecord(value, "evidence gate");
  const kind = requiredString(record.kind, "evidence_gate.kind");
  switch (kind) {
    case "run_completed":
      return { kind };
    case "min_evidence_count":
      return {
        kind,
        min: requiredNumber(record.min, "evidence_gate.min"),
      };
    case "required_evidence_type":
      if (record.min !== undefined) {
        requiredNumber(record.min, "evidence_gate.min");
      }
      return {
        kind,
        evidence_type: requiredString(
          record.evidence_type,
          "evidence_gate.evidence_type",
        ),
        ...(typeof record.min === "number" && Number.isFinite(record.min)
          ? { min: record.min }
          : {}),
      };
    default:
      throw new DeliveryCliError(
        "invalid_input",
        `invalid evidence_gate.kind: ${kind}`,
        "use run_completed, min_evidence_count, or required_evidence_type",
      );
  }
}

function parseAttemptBudget(value: unknown): DeliveryAttemptBudget {
  const record = asRecord(value, "attempt_budget");
  if (record.max_attempts !== undefined) {
    requiredNumber(record.max_attempts, "attempt_budget.max_attempts");
  }
  if (record.max_attempts_per_strategy !== undefined) {
    requiredNumber(
      record.max_attempts_per_strategy,
      "attempt_budget.max_attempts_per_strategy",
    );
  }
  return {
    ...(typeof record.max_attempts === "number" &&
    Number.isFinite(record.max_attempts)
      ? { max_attempts: record.max_attempts }
      : {}),
    ...(typeof record.max_attempts_per_strategy === "number" &&
    Number.isFinite(record.max_attempts_per_strategy)
      ? { max_attempts_per_strategy: record.max_attempts_per_strategy }
      : {}),
  };
}

function validateStrategyReferences(
  strategies: DeliveryStrategy[],
  attempts: DeliveryAttempt[],
  runs: DeliveryRunRef[],
): void {
  const strategyIds = new Set(strategies.map((strategy) => strategy.id));
  for (const attempt of attempts) {
    if (!strategyIds.has(attempt.strategy_id)) {
      throw new DeliveryCliError(
        "invalid_input",
        `attempt.strategy_id references unknown strategy: ${attempt.strategy_id}`,
        "add the strategy to `strategies` or correct the attempt strategy_id",
      );
    }
  }
  for (const run of runs) {
    if (!strategyIds.has(run.strategy_id)) {
      throw new DeliveryCliError(
        "invalid_input",
        `runs[].strategy_id references unknown strategy: ${run.strategy_id}`,
        "add the strategy to `strategies` or correct the run strategy_id",
      );
    }
  }
}

function parseAgentError(value: unknown): AgentError {
  const record = asRecord(value, "attempt.error");
  return {
    code: requiredString(record.code, "attempt.error.code"),
    message: requiredString(record.message, "attempt.error.message"),
    ...(typeof record.adapter_path === "string"
      ? { adapter_path: record.adapter_path }
      : {}),
    ...(typeof record.step === "number" && Number.isFinite(record.step)
      ? { step: record.step }
      : {}),
    ...(typeof record.suggestion === "string"
      ? { suggestion: record.suggestion }
      : {}),
    ...(typeof record.retryable === "boolean"
      ? { retryable: record.retryable }
      : {}),
    ...(Array.isArray(record.alternatives)
      ? {
          alternatives: record.alternatives.filter(
            (entry): entry is string => typeof entry === "string",
          ),
        }
      : {}),
  };
}

function parseRuntimePermissionDenied(
  value: unknown,
): RunSummary["runtime_permission_denied"] {
  const record = asRecord(value, "runtime_permission_denied");
  return {
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    ...(typeof record.action === "string" ? { action: record.action } : {}),
    ...(typeof record.step === "number" && Number.isFinite(record.step)
      ? { step: record.step }
      : {}),
    ...(typeof record.rule_id === "string" ? { rule_id: record.rule_id } : {}),
    ...(Array.isArray(record.resource_buckets)
      ? {
          resource_buckets: record.resource_buckets.filter(
            (entry): entry is string => typeof entry === "string",
          ),
        }
      : {}),
    ...(typeof record.retryable === "boolean"
      ? { retryable: record.retryable }
      : {}),
  };
}

function emitDelivery(
  program: Command,
  command: string,
  startedAt: number,
  data: Record<string, unknown>,
): void {
  console.log(
    format(data, undefined, fmt(program), {
      ...makeCtx(command, startedAt, {
        surface: "system",
        operator: "delivery",
      }),
    }),
  );
}

function emitDeliveryError(
  program: Command,
  command: string,
  startedAt: number,
  err: unknown,
): void {
  const error = agentErrorFromUnknown(err);
  printErrorEnvelope({
    fmt: fmt(program),
    exitCode: ExitCode.USAGE_ERROR,
    ctx: {
      ...makeCtx(command, startedAt, {
        surface: "system",
        operator: "delivery",
      }),
      error,
    },
  });
}

function agentErrorFromUnknown(err: unknown): AgentError {
  if (err instanceof DeliveryCliError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.suggestion ? { suggestion: err.suggestion } : {}),
      retryable: false,
    };
  }
  if (err instanceof RunStoreError) {
    return {
      code:
        err.code === "invalid_run_id" || err.code === "malformed_jsonl"
          ? "invalid_input"
          : "internal_error",
      message: err.message,
      suggestion: "run `unicli runs list` and choose an existing run id",
      retryable: false,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: "internal_error",
    message,
    retryable: false,
  };
}

function arrayOrEmpty(value: unknown, label: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new DeliveryCliError(
      "invalid_input",
      `${label} must be an array`,
      "check the delivery spec JSON shape",
    );
  }
  return value;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DeliveryCliError(
      "invalid_input",
      `${label} must be an object`,
      "check the delivery spec JSON shape",
    );
  }
  return value as Record<string, unknown>;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  return { ...asRecord(value, label) };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DeliveryCliError(
      "invalid_input",
      `${label} must be a non-empty string`,
      "check the delivery spec JSON shape",
    );
  }
  return value;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DeliveryCliError(
      "invalid_input",
      `${label} must be a finite number`,
      "check the delivery spec JSON shape",
    );
  }
  return value;
}

function numberRecord(value: unknown, label: string): Record<string, number> {
  const record = asRecord(value, label);
  const parsed: Record<string, number> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw new DeliveryCliError(
        "invalid_input",
        `${label}.${key} must be a finite number`,
        "check the delivery spec JSON shape",
      );
    }
    parsed[key] = entry;
  }
  return parsed;
}

function isDeliveryStrategyKind(value: string): value is DeliveryStrategyKind {
  return ["adapter", "browser", "desktop", "local", "mcp", "manual"].includes(
    value,
  );
}

function isRunTraceStatus(value: string): value is RunTraceStatus {
  return ["completed", "failed", "running", "empty", "unreadable"].includes(
    value,
  );
}
