/**
 * @owner   src/engine/delivery/trajectory.ts
 * @does    Converts delivery state into a reviewable experiment trajectory with observations, hypotheses, and the next executable experiment.
 * @needs   src/engine/delivery/planner.ts, src/engine/delivery/types.ts
 * @feeds   future delivery ledgers, repair bridge, and operator CLI summaries.
 * @breaks  Trajectory output becomes misleading if assessment statuses stop mapping to verification and failure classifications.
 * @invariants non-active assessments never produce next executable experiments.
 * @side-effects none
 * @perf    O(attempts log attempts + strategies + gates) per trajectory.
 * @concurrency pure and reentrant.
 * @test    tests/unit/engine-delivery-trajectory.test.ts
 * @stability experimental
 * @since   2026-05-24
 */

import {
  assessDeliveryState,
  diagnoseDeliveryAttempt,
  evaluateDeliveryGates,
} from "./planner.js";
import type {
  DeliveryAssessment,
  DeliveryAttempt,
  DeliveryDiagnosisCode,
  DeliveryFailureClassification,
  DeliveryNextExperiment,
  DeliveryStrategy,
  DeliveryTrajectory,
  DeliveryTrajectoryInput,
  DeliveryTrialRecord,
  DeliveryVerificationStatus,
} from "./types.js";

export function buildDeliveryTrajectory(
  input: DeliveryTrajectoryInput,
): DeliveryTrajectory {
  const assessment = assessDeliveryState(input);
  const strategiesById = new Map(
    input.strategies.map((strategy) => [strategy.id, strategy]),
  );
  const trials = [...input.attempts]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((attempt) => {
      const gateResults = evaluateDeliveryGates(input.objective, attempt);
      return trialRecordFromAttempt({
        attempt,
        assessment:
          attempt.id === assessment.current_attempt_id ? assessment : undefined,
        gateResults,
      });
    });
  const verificationStatus = verificationStatusFromAssessment(assessment);
  const nextExperiment =
    verificationStatus === "active"
      ? nextExperimentFromAssessment(assessment, strategiesById)
      : undefined;

  return {
    schema_version: "1",
    objective_id: input.objective.id,
    goal: input.objective.goal,
    recorded_at: input.recorded_at ?? new Date().toISOString(),
    verification_status: verificationStatus,
    assessment,
    trials,
    ...(nextExperiment ? { next_experiment: nextExperiment } : {}),
  };
}

function trialRecordFromAttempt(input: {
  attempt: DeliveryAttempt;
  assessment?: DeliveryAssessment;
  gateResults: ReturnType<typeof evaluateDeliveryGates>;
}): DeliveryTrialRecord {
  const failedGates = input.gateResults
    .filter((gate) => !gate.passed)
    .map((gate) => gate.name);
  const status =
    input.assessment?.status ?? trialStatus(input.attempt, failedGates);
  const diagnosis =
    input.assessment?.diagnosis ??
    diagnosisForHistoricalAttempt(
      input.attempt,
      input.gateResults,
      failedGates,
    );
  const verificationStatus = verificationStatusFromTrial(status);
  return {
    id: input.attempt.id,
    ordinal: input.attempt.ordinal,
    run_id: input.attempt.run_id,
    strategy_id: input.attempt.strategy_id,
    status,
    verification_status: verificationStatus,
    failed_gates: failedGates,
    classification: classifyTrial(diagnosis?.code, status),
    ...(diagnosis?.code ? { diagnosis_code: diagnosis.code } : {}),
    hypothesis: input.assessment?.hypothesis?.reason,
  };
}

function diagnosisForHistoricalAttempt(
  attempt: DeliveryAttempt,
  gateResults: ReturnType<typeof evaluateDeliveryGates>,
  failedGates: string[],
): ReturnType<typeof diagnoseDeliveryAttempt> | undefined {
  if (
    failedGates.length === 0 &&
    !attempt.error &&
    !attempt.summary.runtime_permission_denied
  ) {
    return undefined;
  }
  return diagnoseDeliveryAttempt(attempt, gateResults);
}

function nextExperimentFromAssessment(
  assessment: DeliveryAssessment,
  strategiesById: Map<string, DeliveryStrategy>,
): DeliveryNextExperiment | undefined {
  const strategyId =
    assessment.next_strategy_id ?? assessment.hypothesis?.strategy_id;
  if (!strategyId) return undefined;
  const strategy = strategiesById.get(strategyId);
  if (!strategy) return undefined;
  return {
    action: assessment.next_action,
    strategy_id: strategy.id,
    ...(strategy.command ? { command: strategy.command } : {}),
    ...(assessment.hypothesis?.target
      ? { target: assessment.hypothesis.target }
      : strategy.adapter_path
        ? { target: strategy.adapter_path }
        : {}),
    ...(strategy.verify_command
      ? { verify_command: strategy.verify_command }
      : {}),
    disproof: disproofForAction(assessment.next_action),
  };
}

function verificationStatusFromAssessment(
  assessment: DeliveryAssessment,
): DeliveryVerificationStatus {
  switch (assessment.status) {
    case "delivered":
      return "verified";
    case "blocked":
      return "blocked";
    case "exhausted":
      return "exhausted";
    case "ready":
    case "needs_retry":
    case "needs_repair":
    case "inconclusive":
      return "active";
  }
}

function verificationStatusFromTrial(
  status: DeliveryAssessment["status"],
): DeliveryVerificationStatus {
  switch (status) {
    case "delivered":
      return "verified";
    case "blocked":
      return "blocked";
    case "exhausted":
      return "exhausted";
    case "ready":
    case "needs_retry":
    case "needs_repair":
    case "inconclusive":
      return "active";
  }
}

function trialStatus(
  attempt: DeliveryAttempt,
  failedGates: string[],
): DeliveryAssessment["status"] {
  return attempt.summary.status === "completed" && failedGates.length === 0
    ? "delivered"
    : "inconclusive";
}

function classifyTrial(
  diagnosisCode: DeliveryDiagnosisCode | undefined,
  status: DeliveryAssessment["status"],
): DeliveryFailureClassification {
  if (status === "delivered") return "inconclusive";
  switch (diagnosisCode) {
    case "adapter_drift":
    case "output_contract_mismatch":
    case "evidence_gate_failed":
      return "product_defect";
    case "auth_required":
      return "missing_context";
    case "permission_denied":
      return "user_or_policy_block";
    case "transient_upstream":
      return "upstream_or_environment";
    case "strategy_exhausted":
    case "unknown_failure":
    default:
      return "inconclusive";
  }
}

function disproofForAction(action: DeliveryAssessment["next_action"]): string {
  switch (action) {
    case "repair_adapter":
      return "The next run still fails the same evidence gates or diagnosis.";
    case "retry_strategy":
      return "A repeated run still fails the same evidence gates.";
    case "switch_strategy":
    case "run_strategy":
      return "The selected strategy cannot satisfy the objective evidence gates.";
    case "request_auth":
    case "request_permission":
    case "inspect_failure":
    case "stop":
      return "No executable experiment is available from this assessment.";
  }
}
