import { readFile } from "node:fs/promises";

import {
  discoverEvalFiles,
  findEvalFiles,
  loadEvalFile,
  runCase,
} from "../../commands/eval.js";
import { resolveCommand } from "../../registry.js";
import type {
  AdapterArg,
  AdapterCommand,
  OperationEffect,
} from "../../types.js";
import {
  extractRunReplayInvocation,
  type RunReplayInvocation,
} from "../session/replay.js";
import { stableRunJson } from "../session/args.js";
import { createRunStore, readRunEvents } from "../session/store.js";
import {
  assertEvolutionScopeUnchanged,
  createUnifiedAdapterDiff,
  normalizeEvolutionEvalTargets,
  normalizeEvolutionPrediction,
  parseAdapterYaml,
} from "./candidate.js";
import { EvolutionError } from "./error.js";
import {
  evolutionAttemptPaths,
  evolutionSessionPaths,
  readEvolutionSession,
  sha256Text,
  withEvolutionSessionLock,
  writeEvolutionSession,
  writePrivateJson,
  writePrivateText,
  type EvolutionStore,
} from "./store.js";
import type {
  EvolutionCase,
  EvolutionCaseOutcome,
  EvolutionPrediction,
  EvolutionScore,
  EvolutionSession,
  EvolutionSplitComparison,
  EvolutionVerificationReport,
} from "./types.js";

export async function verifyEvolutionSession(input: {
  store: EvolutionStore;
  sessionId: string;
  adapterCommand: AdapterCommand;
  validationEvalTargets?: string[];
  heldOutEvalTargets?: string[];
  cliCommand?: string;
  timeoutMs?: number;
  allowMutationEval?: boolean;
  prediction?: EvolutionPrediction;
  verifiedAt?: string;
}): Promise<{
  session: EvolutionSession;
  report: EvolutionVerificationReport;
}> {
  const session = await readEvolutionSession(input.store, input.sessionId);
  if (session.state === "promoted" || session.state === "rolled_back") {
    throw new EvolutionError(
      "invalid_state",
      `cannot verify a ${session.state} evolution session`,
    );
  }
  const paths = evolutionSessionPaths(
    input.store,
    session.session_id,
    session.component.site,
    session.component.command,
  );
  const baseline = await readFile(paths.baseline_file, "utf-8");
  const candidate = await readFile(paths.candidate_file, "utf-8");
  if (sha256Text(baseline) !== session.baseline.sha256) {
    throw new EvolutionError(
      "invalid_state",
      "the isolated baseline changed after session creation; create a new evolution session",
    );
  }
  const baselineAdapter = parseAdapterYaml(
    baseline,
    session.component.command,
    paths.baseline_file,
  );
  const candidateAdapter = parseAdapterYaml(
    candidate,
    session.component.command,
    paths.candidate_file,
  );
  assertEvolutionScopeUnchanged(
    baselineAdapter,
    candidateAdapter,
    paths.candidate_file,
    session.component.scope.approved_network_origins,
  );

  const allowMutationEval =
    input.allowMutationEval ?? session.runtime.allow_mutation_eval;
  assertEffectCanBeEvaluated(
    session.component.id,
    session.component.scope.operation_effect,
    allowMutationEval,
  );

  const runStore = createRunStore({ rootDir: session.runtime.run_root });
  const addedValidationTargets = normalizeEvolutionEvalTargets(
    input.validationEvalTargets ?? [],
  );
  const addedHeldOutTargets = normalizeEvolutionEvalTargets(
    input.heldOutEvalTargets ?? [],
  );
  const validationCases = [
    ...(await runCases(
      runStore,
      session.datasets.validation_run_ids,
      session.component.site,
      session.component.command,
      input.adapterCommand,
      "validation",
    )),
    ...evalCases(
      unique([
        ...session.datasets.validation_eval_targets,
        ...addedValidationTargets,
      ]),
      session.component.site,
      "validation",
    ),
  ];
  const explicitHeldOutTargets = unique([
    ...session.datasets.held_out_eval_targets,
    ...addedHeldOutTargets,
  ]);
  const heldOutTargets =
    explicitHeldOutTargets.length > 0
      ? explicitHeldOutTargets
      : autoDiscoveredEvalTargets(session.component.site);
  const heldOutCases = [
    ...(await runCases(
      runStore,
      session.datasets.held_out_run_ids,
      session.component.site,
      session.component.command,
      input.adapterCommand,
      "held-out",
    )),
    ...evalCases(heldOutTargets, session.component.site, "held-out"),
  ];
  assertIndependentSplits(validationCases, heldOutCases);
  assertCaseEffects(
    session.component.site,
    [...validationCases, ...heldOutCases],
    allowMutationEval,
  );

  const cliCommand = input.cliCommand ?? session.runtime.cli_command;
  const timeoutMs = input.timeoutMs ?? session.runtime.timeout_ms;
  const baselineEnv: NodeJS.ProcessEnv = {
    UNICLI_USER_ADAPTER_DIR: paths.baseline_overlay,
    UNICLI_RECORD_RUN: "1",
    UNICLI_RUN_ROOT: paths.baseline_runs,
    UNICLI_PERMISSION_PROFILE: session.component.scope.permission_profile,
    UNICLI_SKIP_UPDATE_CHECK: "1",
    UNICLI_DISABLE_AUTO_UPDATE: "1",
    ...(allowMutationEval ? { UNICLI_APPROVE: "1" } : {}),
  };
  const candidateEnv: NodeJS.ProcessEnv = {
    ...baselineEnv,
    UNICLI_USER_ADAPTER_DIR: paths.candidate_overlay,
    UNICLI_RUN_ROOT: paths.candidate_runs,
  };

  const validation = compareSplit(
    "validation",
    session.component.site,
    validationCases,
    cliCommand,
    timeoutMs,
    baselineEnv,
    candidateEnv,
  );
  const heldOut = compareSplit(
    "held-out",
    session.component.site,
    heldOutCases,
    cliCommand,
    timeoutMs,
    baselineEnv,
    candidateEnv,
  );
  const diff = createUnifiedAdapterDiff({
    baseline,
    candidate,
    baselineLabel: `baseline/${session.component.site}/${session.component.command}.yaml`,
    candidateLabel: `candidate/${session.component.site}/${session.component.command}.yaml`,
  });

  const candidateSha256 = sha256Text(candidate);
  const candidateChanged = candidateSha256 !== session.baseline.sha256;
  const prediction = normalizeEvolutionPrediction(
    input.prediction ?? session.prediction,
  );
  if (!prediction) {
    throw new EvolutionError(
      "invalid_case",
      "candidate verification requires a falsifiable hypothesis and expected fixes",
    );
  }
  const strictValidationImprovement =
    validation.candidate.passed > validation.baseline.passed &&
    validation.regressions.length === 0;
  const heldOutPresent = heldOut.candidate.total > 0;
  const heldOutNoRegression =
    heldOutPresent &&
    heldOut.candidate.passed >= heldOut.baseline.passed &&
    heldOut.regressions.length === 0;
  const reasons: string[] = [];
  if (!candidateChanged) reasons.push("candidate is identical to baseline");
  if (validation.candidate.total === 0) {
    reasons.push("validation has no executable cases");
  } else if (!strictValidationImprovement) {
    reasons.push(
      "candidate did not strictly improve validation without regressions",
    );
  }
  if (!heldOutPresent) reasons.push("held-out evaluation has no cases");
  else if (!heldOutNoRegression)
    reasons.push("candidate regressed on held-out cases");
  const eligible =
    candidateChanged && strictValidationImprovement && heldOutNoRegression;
  if (eligible) reasons.push("candidate passed the promotion gate");

  const verifiedAt = input.verifiedAt ?? new Date().toISOString();
  const predictionResult = evaluatePrediction(
    prediction,
    [...validation.improvements, ...heldOut.improvements],
    [...validation.regressions, ...heldOut.regressions],
  );
  return withEvolutionSessionLock(input.store, session.session_id, async () => {
    const current = await readEvolutionSession(input.store, session.session_id);
    if (current.state === "promoted" || current.state === "rolled_back") {
      throw new EvolutionError(
        "invalid_state",
        `cannot record an attempt for a ${current.state} evolution session`,
      );
    }
    if (
      sha256Text(await readFile(paths.candidate_file, "utf-8")) !==
      candidateSha256
    ) {
      throw new EvolutionError(
        "candidate_changed",
        "candidate changed during verification; verify the current candidate again",
        paths.candidate_file,
      );
    }
    const ordinal = current.attempts.length + 1;
    const attempt = evolutionAttemptPaths(paths, ordinal);
    const report: EvolutionVerificationReport = {
      schema_version: "unicli.evolution-verification.v1",
      session_id: session.session_id,
      verified_at: verifiedAt,
      component_id: session.component.id,
      baseline_sha256: session.baseline.sha256,
      candidate_sha256: candidateSha256,
      attempt: ordinal,
      candidate_path: attempt.candidate,
      patch_path: attempt.patch,
      changed_lines: { added: diff.added, removed: diff.removed },
      prediction: predictionResult,
      validation,
      held_out: heldOut,
      decision: {
        eligible,
        candidate_changed: candidateChanged,
        candidate_valid: true,
        strict_validation_improvement: strictValidationImprovement,
        held_out_present: heldOutPresent,
        held_out_no_regression: heldOutNoRegression,
        reasons,
      },
    };
    await writePrivateText(attempt.candidate, candidate);
    await writePrivateText(attempt.patch, diff.patch);
    const reportSha256 = await writePrivateJson(attempt.report, report);

    const updated: EvolutionSession = {
      ...current,
      state: eligible ? "verified" : "rejected",
      updated_at: verifiedAt,
      candidate: { path: paths.candidate_file, sha256: candidateSha256 },
      datasets: {
        ...current.datasets,
        validation_eval_targets: unique([
          ...current.datasets.validation_eval_targets,
          ...addedValidationTargets,
        ]),
        held_out_eval_targets: unique([
          ...current.datasets.held_out_eval_targets,
          ...addedHeldOutTargets,
        ]),
      },
      runtime: {
        ...current.runtime,
        cli_command: cliCommand,
        timeout_ms: timeoutMs,
        allow_mutation_eval: allowMutationEval,
      },
      prediction,
      attempts: [
        ...current.attempts,
        {
          ordinal,
          verified_at: verifiedAt,
          eligible,
          candidate: { path: attempt.candidate, sha256: candidateSha256 },
          patch: { path: attempt.patch, sha256: sha256Text(diff.patch) },
          report: { path: attempt.report, sha256: reportSha256 },
        },
      ],
    };
    await writeEvolutionSession(input.store, updated);
    return { session: updated, report };
  });
}

function evaluatePrediction(
  prediction: EvolutionPrediction,
  improvements: string[],
  regressions: string[],
): EvolutionVerificationReport["prediction"] {
  const expectedFixed = prediction.expected_fixes.filter((reference) =>
    improvements.some((id) => matchesCaseReference(id, reference)),
  );
  return {
    ...prediction,
    expected_fixed: expectedFixed,
    expected_missed: prediction.expected_fixes.filter(
      (reference) => !expectedFixed.includes(reference),
    ),
    at_risk_regressions: prediction.at_risk.filter((reference) =>
      regressions.some((id) => matchesCaseReference(id, reference)),
    ),
    unexpected_regressions: regressions.filter(
      (id) =>
        !prediction.at_risk.some((reference) =>
          matchesCaseReference(id, reference),
        ),
    ),
  };
}

function matchesCaseReference(id: string, reference: string): boolean {
  return id === reference || id.endsWith(`:${reference}`);
}

function compareSplit(
  split: EvolutionSplitComparison["split"],
  site: string,
  cases: EvolutionCase[],
  cliCommand: string,
  timeoutMs: number,
  baselineEnv: NodeJS.ProcessEnv,
  candidateEnv: NodeJS.ProcessEnv,
): EvolutionSplitComparison {
  const baselineOutcomes: EvolutionCaseOutcome[] = [];
  const candidateOutcomes: EvolutionCaseOutcome[] = [];
  cases.forEach((evolutionCase, index) => {
    const runBaseline = () =>
      runEvolutionCase(site, evolutionCase, cliCommand, timeoutMs, baselineEnv);
    const runCandidate = () =>
      runEvolutionCase(
        site,
        evolutionCase,
        cliCommand,
        timeoutMs,
        candidateEnv,
      );
    if (index % 2 === 0) {
      baselineOutcomes.push(runBaseline());
      candidateOutcomes.push(runCandidate());
    } else {
      candidateOutcomes.push(runCandidate());
      baselineOutcomes.push(runBaseline());
    }
  });
  const baseline = scoreOutcomes(baselineOutcomes);
  const candidate = scoreOutcomes(candidateOutcomes);
  const baselineById = new Map(
    baseline.cases.map((outcome) => [outcome.id, outcome]),
  );
  const improvements: string[] = [];
  const regressions: string[] = [];
  for (const outcome of candidate.cases) {
    const previous = baselineById.get(outcome.id);
    if (!previous) continue;
    if (!previous.passed && outcome.passed) improvements.push(outcome.id);
    if (previous.passed && !outcome.passed) regressions.push(outcome.id);
  }
  const durationDelta = candidate.duration_ms - baseline.duration_ms;
  return {
    split,
    baseline,
    candidate,
    improvements,
    regressions,
    cost: {
      duration_delta_ms: durationDelta,
      duration_ratio:
        baseline.duration_ms > 0
          ? round(candidate.duration_ms / baseline.duration_ms)
          : null,
      token_usage_available: false,
    },
  };
}

function runEvolutionCase(
  site: string,
  evolutionCase: EvolutionCase,
  cliCommand: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): EvolutionCaseOutcome {
  const result = runCase(site, evolutionCase, {
    cliCommand,
    timeout: timeoutMs,
    env,
  });
  return {
    id: evolutionCase.id,
    source: evolutionCase.source,
    source_ref: evolutionCase.source_ref,
    command: evolutionCase.command,
    passed: result.passed,
    exit_code: result.exitCode ?? 1,
    duration_ms: result.durationMs,
    failures: result.judgeResults
      .filter((judge) => !judge.passed)
      .map((judge) => ({
        judge: judge.judge.type,
        ...(judge.reason ? { reason: judge.reason } : {}),
      })),
  };
}

function scoreOutcomes(outcomes: EvolutionCaseOutcome[]): EvolutionScore {
  const passed = outcomes.filter((outcome) => outcome.passed).length;
  return {
    passed,
    total: outcomes.length,
    pass_rate: outcomes.length === 0 ? 0 : round(passed / outcomes.length),
    duration_ms: outcomes.reduce(
      (total, outcome) => total + outcome.duration_ms,
      0,
    ),
    token_usage: null,
    token_usage_available: false,
    cases: outcomes,
  };
}

async function runCases(
  store: ReturnType<typeof createRunStore>,
  runIds: string[],
  site: string,
  command: string,
  adapterCommand: AdapterCommand,
  split: "validation" | "held-out",
): Promise<EvolutionCase[]> {
  const cases: EvolutionCase[] = [];
  for (const runId of unique(runIds)) {
    const events = await readRunEvents(store, runId);
    const replay = extractRunReplayInvocation(events, runId);
    if (!replay || replay.site !== site || replay.cmd !== command) {
      throw new EvolutionError(
        "replay_unavailable",
        `run ${runId} has no replay payload for ${site}.${command}`,
      );
    }
    cases.push(replayEvolutionCase(runId, replay, adapterCommand, split));
  }
  return cases;
}

function replayEvolutionCase(
  runId: string,
  replay: RunReplayInvocation,
  adapterCommand: AdapterCommand,
  split: "validation" | "held-out",
): EvolutionCase {
  const args: Record<string, string | number | boolean> = {};
  const positional: Array<string | number> = [];
  const schemaByName = new Map(
    (adapterCommand.adapterArgs ?? []).map((argument) => [
      argument.name,
      argument,
    ]),
  );
  for (const argument of adapterCommand.adapterArgs ?? []) {
    if (!Object.hasOwn(replay.args, argument.name)) continue;
    const value = replay.args[argument.name];
    const scalar = evalScalar(value, argument, runId);
    if (argument.positional) {
      positional.push(typeof scalar === "boolean" ? String(scalar) : scalar);
    } else args[argument.name] = scalar;
  }
  for (const [name, value] of Object.entries(replay.args)) {
    if (schemaByName.has(name)) continue;
    args[name] = evalScalar(value, undefined, runId);
  }
  const judges: EvolutionCase["judges"] = [{ type: "exitCode", equals: 0 }];
  if (requiresConfirmedEffect(adapterCommand.operation_effect)) {
    judges.push({ type: "effectStatus", equals: "confirmed" });
  }
  return {
    id: `${split}:run:${runId}`,
    source: "run",
    source_ref: runId,
    command: replay.cmd,
    ...(Object.keys(args).length > 0 ? { args } : {}),
    ...(positional.length > 0 ? { positional } : {}),
    judges,
  };
}

function evalCases(
  targets: string[],
  site: string,
  split: "validation" | "held-out",
): EvolutionCase[] {
  const files = unique(
    targets.flatMap((target) => {
      const matches = findEvalFiles([target]);
      if (matches.length === 0) {
        throw new EvolutionError(
          "eval_not_found",
          `eval target not found: ${target}`,
        );
      }
      return matches;
    }),
  );
  const cases: EvolutionCase[] = [];
  for (const filePath of files) {
    const file = loadEvalFile(filePath);
    if (file.adapter !== site) {
      throw new EvolutionError(
        "eval_adapter_mismatch",
        `eval ${filePath} targets ${file.adapter}; expected ${site}`,
      );
    }
    file.cases.forEach((evalCase, index) => {
      if (evalCase.split === "train") return;
      if (evalCase.split && evalCase.split !== split) return;
      cases.push({
        id: `${split}:eval:${sha256Text(filePath).slice(-12)}:${evalCase.id ?? index + 1}`,
        source: "eval",
        source_ref: filePath,
        command: evalCase.command,
        ...(evalCase.args ? { args: { ...evalCase.args } } : {}),
        ...(evalCase.positional
          ? { positional: [...evalCase.positional] }
          : {}),
        judges: evalCase.judges.map((judge) => ({ ...judge })),
      });
    });
  }
  return cases;
}

function assertIndependentSplits(
  validation: EvolutionCase[],
  heldOut: EvolutionCase[],
): void {
  const validationKeys = new Set(validation.map(casePartitionKey));
  const overlap = heldOut.find((entry) =>
    validationKeys.has(casePartitionKey(entry)),
  );
  if (overlap) {
    throw new EvolutionError(
      "invalid_case",
      `case ${overlap.source_ref} is present in validation and held-out evaluation; use disjoint cases or explicit split labels`,
    );
  }
}

function casePartitionKey(entry: EvolutionCase): string {
  if (entry.source === "run") {
    return stableRunJson({
      source: entry.source,
      source_ref: entry.source_ref,
    });
  }
  return stableRunJson({
    source: entry.source,
    command: entry.command,
    args: entry.args ?? null,
    positional: entry.positional ?? null,
    judges: entry.judges,
  });
}

function autoDiscoveredEvalTargets(site: string): string[] {
  return discoverEvalFiles()
    .filter((entry) => {
      try {
        return loadEvalFile(entry.path).adapter === site;
      } catch {
        // REASON: repository-wide auto-discovery must not let a malformed eval
        // for another adapter block an explicitly scoped evolution session.
        return false;
      }
    })
    .map((entry) => entry.path);
}

function assertCaseEffects(
  site: string,
  cases: EvolutionCase[],
  allowMutationEval: boolean,
): void {
  for (const evolutionCase of cases) {
    const resolved = resolveCommand(site, evolutionCase.command);
    if (!resolved) {
      throw new EvolutionError(
        "invalid_case",
        `eval command is not registered: ${site}.${evolutionCase.command}`,
      );
    }
    assertEffectCanBeEvaluated(
      `${site}.${evolutionCase.command}`,
      resolved.command.operation_effect,
      allowMutationEval,
    );
    if (
      requiresConfirmedEffect(resolved.command.operation_effect) &&
      !evolutionCase.judges.some(
        (judge) =>
          judge.type === "effectStatus" && judge.equals === "confirmed",
      )
    ) {
      throw new EvolutionError(
        "invalid_case",
        `eval case ${evolutionCase.id} mutates state without an effectStatus=confirmed verifier`,
        evolutionCase.source_ref,
      );
    }
  }
}

function assertEffectCanBeEvaluated(
  component: string,
  effect: OperationEffect | undefined,
  allowMutationEval: boolean,
): void {
  if (allowMutationEval || effect === "read") {
    return;
  }
  throw new EvolutionError(
    "mutation_eval_blocked",
    `${component} declares ${effect ?? "an unknown effect"}; pass --allow-mutation-eval only in a controlled target environment`,
  );
}

function requiresConfirmedEffect(effect?: OperationEffect): boolean {
  return effect !== undefined && effect !== "read";
}

function evalScalar(
  value: unknown,
  argument: AdapterArg | undefined,
  runId: string,
): string | number | boolean {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  throw new EvolutionError(
    "invalid_case",
    `run ${runId} argument ${argument?.name ?? "value"} cannot be represented by the declarative eval runner`,
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
