/**
 * @owner   src/engine/delivery/planner.ts
 * @does    Evaluates objective attempts against evidence gates and selects the next delivery action.
 * @needs   src/engine/delivery/types.ts
 * @feeds   future objective-level delivery command, repair bridge, and run/session adapters.
 * @breaks  Throws no errors; malformed or exhausted state is surfaced as blocked, exhausted, or inconclusive assessment.
 * @invariants permission/auth blocks never become repair actions; strategy switching skips exhausted strategies.
 * @side-effects none
 * @perf    O(strategies + attempts + gates) per assessment.
 * @concurrency pure and reentrant.
 * @test    tests/unit/engine-delivery.test.ts
 * @stability experimental
 * @since   2026-05-24
 */

import type {
  DeliveryAssessment,
  DeliveryAttempt,
  DeliveryDiagnosis,
  DeliveryEvidenceGate,
  DeliveryGateResult,
  DeliveryHypothesis,
  DeliveryNextAction,
  DeliveryObjective,
  DeliveryStateInput,
  DeliveryStrategy,
} from "./types.js";

const DEFAULT_EVIDENCE_GATES: DeliveryEvidenceGate[] = [
  { kind: "run_completed" },
];

const ADAPTER_DRIFT_CODES = new Set([
  "selector_miss",
  "stale_ref",
  "ref_not_found",
  "ambiguous",
]);

const AUTH_CODES = new Set(["auth_required", "not_authenticated"]);

const OUTPUT_CONTRACT_CODES = new Set([
  "invalid_input",
  "schema_mismatch",
  "shape_mismatch",
]);

const TRANSIENT_CODES = new Set([
  "network_error",
  "rate_limited",
  "upstream_error",
  "api_error",
]);

export function assessDeliveryState(
  input: DeliveryStateInput,
): DeliveryAssessment {
  const strategies = enabledStrategies(input.strategies);
  const currentAttempt = latestAttempt(input.attempts);
  if (!currentAttempt) {
    const firstStrategy = strategies[0];
    return {
      objective_id: input.objective.id,
      status: firstStrategy ? "ready" : "blocked",
      next_action: firstStrategy ? "run_strategy" : "inspect_failure",
      gates: [],
      ...(firstStrategy ? { next_strategy_id: firstStrategy.id } : {}),
    };
  }

  const gates = evaluateDeliveryGates(input.objective, currentAttempt);
  if (gates.length > 0 && gates.every((gate) => gate.passed)) {
    return {
      objective_id: input.objective.id,
      status: "delivered",
      next_action: "stop",
      gates,
      current_attempt_id: currentAttempt.id,
      current_strategy_id: currentAttempt.strategy_id,
    };
  }

  const currentStrategy = strategies.find(
    (strategy) => strategy.id === currentAttempt.strategy_id,
  );
  const diagnosis = diagnoseDeliveryAttempt(currentAttempt, gates);
  return planRecovery({
    objective: input.objective,
    attempts: input.attempts,
    strategies,
    currentAttempt,
    currentStrategy,
    gates,
    diagnosis,
  });
}

export function evaluateDeliveryGates(
  objective: DeliveryObjective,
  attempt: DeliveryAttempt,
): DeliveryGateResult[] {
  return evidenceGates(objective).map((gate) =>
    evaluateDeliveryGate(gate, attempt),
  );
}

function planRecovery(input: {
  objective: DeliveryObjective;
  attempts: DeliveryAttempt[];
  strategies: DeliveryStrategy[];
  currentAttempt: DeliveryAttempt;
  currentStrategy?: DeliveryStrategy;
  gates: DeliveryGateResult[];
  diagnosis: DeliveryDiagnosis;
}): DeliveryAssessment {
  const nextStrategy = nextAvailableStrategy(
    input.objective,
    input.attempts,
    input.strategies,
    input.currentAttempt.strategy_id,
  );
  const isGlobalExhausted = hasGlobalAttemptBudgetExhausted(
    input.objective,
    input.attempts,
  );
  const isCurrentStrategyExhausted = hasStrategyAttemptBudgetExhausted(
    input.objective,
    input.attempts,
    input.currentAttempt.strategy_id,
  );
  const base = {
    objective_id: input.objective.id,
    gates: input.gates,
    current_attempt_id: input.currentAttempt.id,
    current_strategy_id: input.currentAttempt.strategy_id,
    diagnosis: input.diagnosis,
  };

  if (input.diagnosis.code === "permission_denied") {
    return { ...base, status: "blocked", next_action: "request_permission" };
  }
  if (input.diagnosis.code === "auth_required") {
    return { ...base, status: "blocked", next_action: "request_auth" };
  }
  if (isGlobalExhausted) {
    return exhaustedAssessment(
      base,
      input.currentAttempt,
      input.currentStrategy,
    );
  }
  if (isCurrentStrategyExhausted && nextStrategy) {
    return {
      ...base,
      status: "needs_retry",
      next_action: "switch_strategy",
      next_strategy_id: nextStrategy.id,
      hypothesis: createHypothesis({
        action: "switch_strategy",
        diagnosis: input.diagnosis,
        attempt: input.currentAttempt,
        strategy: nextStrategy,
      }),
    };
  }
  if (input.diagnosis.repairable) {
    return {
      ...base,
      status: "needs_repair",
      next_action: "repair_adapter",
      hypothesis: createHypothesis({
        action: "repair_adapter",
        diagnosis: input.diagnosis,
        attempt: input.currentAttempt,
        strategy: input.currentStrategy,
      }),
    };
  }
  if (input.diagnosis.retryable && !isCurrentStrategyExhausted) {
    return {
      ...base,
      status: "needs_retry",
      next_action: "retry_strategy",
      next_strategy_id: input.currentAttempt.strategy_id,
      hypothesis: createHypothesis({
        action: "retry_strategy",
        diagnosis: input.diagnosis,
        attempt: input.currentAttempt,
        strategy: input.currentStrategy,
      }),
    };
  }
  if (nextStrategy) {
    return {
      ...base,
      status: "needs_retry",
      next_action: "switch_strategy",
      next_strategy_id: nextStrategy.id,
    };
  }
  return exhaustedAssessment(base, input.currentAttempt, input.currentStrategy);
}

function exhaustedAssessment(
  base: Omit<DeliveryAssessment, "status" | "next_action">,
  attempt: DeliveryAttempt,
  strategy?: DeliveryStrategy,
): DeliveryAssessment {
  const diagnosis: DeliveryDiagnosis =
    base.diagnosis?.code === "strategy_exhausted"
      ? base.diagnosis
      : {
          code: "strategy_exhausted",
          reason: "No remaining enabled strategy can satisfy the objective.",
          repairable: false,
          retryable: false,
        };
  return {
    ...base,
    status: "exhausted",
    next_action: "inspect_failure",
    diagnosis,
    hypothesis: createHypothesis({
      action: "inspect_failure",
      diagnosis,
      attempt,
      strategy,
    }),
  };
}

export function diagnoseDeliveryAttempt(
  attempt: DeliveryAttempt,
  gates: DeliveryGateResult[],
): DeliveryDiagnosis {
  const error = attempt.error;
  const errorCode = error?.code;
  const permissionDenied = attempt.summary.runtime_permission_denied;

  if (permissionDenied || errorCode === "permission_denied") {
    return {
      code: "permission_denied",
      reason: "Runtime policy denied access to a required resource.",
      repairable: false,
      retryable: false,
      ...(error?.adapter_path ? { adapter_path: error.adapter_path } : {}),
      ...(typeof error?.step === "number" ? { step: error.step } : {}),
      ...(error?.suggestion ? { suggestion: error.suggestion } : {}),
    };
  }
  if (errorCode && AUTH_CODES.has(errorCode)) {
    return {
      code: "auth_required",
      reason: "The operation needs authenticated state before it can proceed.",
      repairable: false,
      retryable: false,
      ...(error?.adapter_path ? { adapter_path: error.adapter_path } : {}),
      ...(typeof error?.step === "number" ? { step: error.step } : {}),
      ...(error?.suggestion ? { suggestion: error.suggestion } : {}),
    };
  }
  if (errorCode && ADAPTER_DRIFT_CODES.has(errorCode)) {
    return {
      code: "adapter_drift",
      reason: "The adapter path no longer matches the live software surface.",
      repairable: Boolean(error.adapter_path),
      retryable: error.retryable !== false,
      ...(error.adapter_path ? { adapter_path: error.adapter_path } : {}),
      ...(typeof error.step === "number" ? { step: error.step } : {}),
      ...(error.suggestion ? { suggestion: error.suggestion } : {}),
    };
  }
  if (errorCode && OUTPUT_CONTRACT_CODES.has(errorCode)) {
    return {
      code: "output_contract_mismatch",
      reason: "The latest result did not match the expected output contract.",
      repairable: Boolean(error.adapter_path),
      retryable: error.retryable !== false,
      ...(error.adapter_path ? { adapter_path: error.adapter_path } : {}),
      ...(typeof error.step === "number" ? { step: error.step } : {}),
      ...(error.suggestion ? { suggestion: error.suggestion } : {}),
    };
  }
  if (errorCode && TRANSIENT_CODES.has(errorCode)) {
    return {
      code: "transient_upstream",
      reason: "The run failed on a transient upstream or transport condition.",
      repairable: false,
      retryable: error.retryable !== false,
      ...(error.adapter_path ? { adapter_path: error.adapter_path } : {}),
      ...(typeof error.step === "number" ? { step: error.step } : {}),
      ...(error.suggestion ? { suggestion: error.suggestion } : {}),
    };
  }
  if (gates.some((gate) => !gate.passed)) {
    return {
      code: "evidence_gate_failed",
      reason: "The run completed without enough evidence to prove delivery.",
      repairable: false,
      retryable: true,
    };
  }
  return {
    code: "unknown_failure",
    reason:
      "The attempt did not satisfy the objective and has no known diagnosis.",
    repairable: false,
    retryable: error?.retryable === true,
    ...(error?.adapter_path ? { adapter_path: error.adapter_path } : {}),
    ...(typeof error?.step === "number" ? { step: error.step } : {}),
    ...(error?.suggestion ? { suggestion: error.suggestion } : {}),
  };
}

function evaluateDeliveryGate(
  gate: DeliveryEvidenceGate,
  attempt: DeliveryAttempt,
): DeliveryGateResult {
  switch (gate.kind) {
    case "run_completed":
      return {
        name: "run_completed",
        kind: gate.kind,
        passed: attempt.summary.status === "completed",
        expected: "completed",
        actual: attempt.summary.status,
      };
    case "min_evidence_count":
      return {
        name: "min_evidence_count",
        kind: gate.kind,
        passed: attempt.summary.evidence_count >= gate.min,
        expected: gate.min,
        actual: attempt.summary.evidence_count,
      };
    case "required_evidence_type": {
      const actual = attempt.summary.evidence_by_type[gate.evidence_type] ?? 0;
      const expected = gate.min ?? 1;
      return {
        name: `evidence_type:${gate.evidence_type}`,
        kind: gate.kind,
        passed: actual >= expected,
        expected,
        actual,
      };
    }
  }
}

function createHypothesis(input: {
  action: DeliveryNextAction;
  diagnosis: DeliveryDiagnosis;
  attempt: DeliveryAttempt;
  strategy?: DeliveryStrategy;
}): DeliveryHypothesis {
  const target = input.diagnosis.adapter_path ?? input.strategy?.adapter_path;
  return {
    id: `${input.attempt.id}:${input.diagnosis.code}:${input.action}`,
    diagnosis_code: input.diagnosis.code,
    action: input.action,
    reason: input.diagnosis.suggestion ?? input.diagnosis.reason,
    ...(input.strategy ? { strategy_id: input.strategy.id } : {}),
    ...(target ? { target } : {}),
    ...(input.strategy?.verify_command
      ? { verify_command: input.strategy.verify_command }
      : {}),
  };
}

function evidenceGates(objective: DeliveryObjective): DeliveryEvidenceGate[] {
  return objective.evidence_gates && objective.evidence_gates.length > 0
    ? objective.evidence_gates
    : DEFAULT_EVIDENCE_GATES;
}

function latestAttempt(
  attempts: DeliveryAttempt[],
): DeliveryAttempt | undefined {
  const sorted = [...attempts].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
  return sorted[sorted.length - 1];
}

function enabledStrategies(strategies: DeliveryStrategy[]): DeliveryStrategy[] {
  return [...strategies]
    .filter((strategy) => strategy.enabled !== false)
    .sort((left, right) => {
      const priority = left.priority - right.priority;
      return priority === 0 ? left.id.localeCompare(right.id) : priority;
    });
}

function nextAvailableStrategy(
  objective: DeliveryObjective,
  attempts: DeliveryAttempt[],
  strategies: DeliveryStrategy[],
  currentStrategyId: string,
): DeliveryStrategy | undefined {
  return strategies.find(
    (strategy) =>
      strategy.id !== currentStrategyId &&
      !hasStrategyAttemptBudgetExhausted(objective, attempts, strategy.id),
  );
}

function hasGlobalAttemptBudgetExhausted(
  objective: DeliveryObjective,
  attempts: DeliveryAttempt[],
): boolean {
  const maxAttempts = objective.attempt_budget?.max_attempts;
  return typeof maxAttempts === "number" && attempts.length >= maxAttempts;
}

function hasStrategyAttemptBudgetExhausted(
  objective: DeliveryObjective,
  attempts: DeliveryAttempt[],
  strategyId: string,
): boolean {
  const maxAttempts = objective.attempt_budget?.max_attempts_per_strategy;
  if (typeof maxAttempts !== "number") return false;
  return (
    attempts.filter((attempt) => attempt.strategy_id === strategyId).length >=
    maxAttempts
  );
}
