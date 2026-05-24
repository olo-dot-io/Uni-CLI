/**
 * @owner   src/engine/delivery/types.ts
 * @does    Defines objective-level delivery contracts: strategies, attempts, evidence gates, diagnoses, and next actions.
 * @needs   src/output/envelope.ts, src/engine/session/query.ts, src/engine/session/types.ts
 * @feeds   src/engine/delivery/planner.ts, src/engine/delivery/repair.ts, and future objective-level CLI orchestration.
 * @breaks  Misclassified status fields can make repairable, retryable, and blocked failures indistinguishable.
 * @invariants repair candidates require both an adapter path and verification command.
 * @side-effects none
 * @perf    type-only module.
 * @concurrency type-only module.
 * @test    tests/unit/engine-delivery*.test.ts
 * @stability experimental
 * @since   2026-05-24
 */

import type { AgentError } from "../../output/envelope.js";
import type { RunSummary } from "../session/query.js";
import type { RunEvent, RunId } from "../session/types.js";

export type DeliveryStrategyKind =
  | "adapter"
  | "browser"
  | "desktop"
  | "local"
  | "mcp"
  | "manual";

export interface DeliveryStrategy {
  id: string;
  kind: DeliveryStrategyKind;
  label: string;
  priority: number;
  enabled?: boolean;
  command?: string;
  args?: Record<string, unknown>;
  adapter_path?: string;
  verify_command?: string;
}

export interface DeliveryAttemptBudget {
  max_attempts?: number;
  max_attempts_per_strategy?: number;
}

export type DeliveryEvidenceGate =
  | { kind: "run_completed" }
  | { kind: "min_evidence_count"; min: number }
  | { kind: "required_evidence_type"; evidence_type: string; min?: number };

export interface DeliveryObjective {
  id: string;
  goal: string;
  evidence_gates?: DeliveryEvidenceGate[];
  attempt_budget?: DeliveryAttemptBudget;
}

export interface DeliveryAttempt {
  id: string;
  ordinal: number;
  strategy_id: string;
  run_id: RunId;
  summary: RunSummary;
  error?: AgentError;
}

export interface DeliveryGateResult {
  name: string;
  kind: DeliveryEvidenceGate["kind"];
  passed: boolean;
  expected: string | number;
  actual: string | number;
}

export type DeliveryDiagnosisCode =
  | "adapter_drift"
  | "auth_required"
  | "evidence_gate_failed"
  | "output_contract_mismatch"
  | "permission_denied"
  | "strategy_exhausted"
  | "transient_upstream"
  | "unknown_failure";

export interface DeliveryDiagnosis {
  code: DeliveryDiagnosisCode;
  reason: string;
  repairable: boolean;
  retryable: boolean;
  adapter_path?: string;
  step?: number;
  suggestion?: string;
}

export type DeliveryStatus =
  | "ready"
  | "delivered"
  | "needs_retry"
  | "needs_repair"
  | "blocked"
  | "exhausted"
  | "inconclusive";

export type DeliveryNextAction =
  | "run_strategy"
  | "stop"
  | "retry_strategy"
  | "repair_adapter"
  | "switch_strategy"
  | "request_auth"
  | "request_permission"
  | "inspect_failure";

export interface DeliveryHypothesis {
  id: string;
  diagnosis_code: DeliveryDiagnosisCode;
  action: DeliveryNextAction;
  reason: string;
  strategy_id?: string;
  target?: string;
  verify_command?: string;
}

export interface DeliveryAssessment {
  objective_id: string;
  status: DeliveryStatus;
  next_action: DeliveryNextAction;
  gates: DeliveryGateResult[];
  current_attempt_id?: string;
  current_strategy_id?: string;
  next_strategy_id?: string;
  diagnosis?: DeliveryDiagnosis;
  hypothesis?: DeliveryHypothesis;
}

export interface DeliveryStateInput {
  objective: DeliveryObjective;
  strategies: DeliveryStrategy[];
  attempts: DeliveryAttempt[];
}

export type DeliveryVerificationStatus =
  | "unverified"
  | "active"
  | "verified"
  | "blocked"
  | "exhausted";

export type DeliveryFailureClassification =
  | "product_defect"
  | "missing_context"
  | "user_or_policy_block"
  | "upstream_or_environment"
  | "inconclusive";

export interface DeliveryTrialRecord {
  id: string;
  ordinal: number;
  run_id: RunId;
  strategy_id: string;
  status: DeliveryStatus;
  verification_status: DeliveryVerificationStatus;
  failed_gates: string[];
  classification: DeliveryFailureClassification;
  diagnosis_code?: DeliveryDiagnosisCode;
  hypothesis?: string;
}

export interface DeliveryNextExperiment {
  action: DeliveryNextAction;
  strategy_id: string;
  command?: string;
  target?: string;
  verify_command?: string;
  disproof: string;
}

export interface DeliveryTrajectory {
  schema_version: "1";
  objective_id: string;
  goal: string;
  recorded_at: string;
  verification_status: DeliveryVerificationStatus;
  assessment: DeliveryAssessment;
  trials: DeliveryTrialRecord[];
  next_experiment?: DeliveryNextExperiment;
}

export interface DeliveryTrajectoryInput extends DeliveryStateInput {
  recorded_at?: string;
}

export interface DeliveryAttemptFromRunEventsInput {
  id: string;
  ordinal: number;
  strategy_id: string;
  events: RunEvent[];
  run_id?: RunId;
}

export interface DeliveryRepairCandidate {
  schema_version: "1";
  objective_id: string;
  attempt_id: string;
  strategy_id: string;
  adapter_path: string;
  verify_command: string;
  diagnosis_code: DeliveryDiagnosisCode;
  reason: string;
  command?: string;
  step?: number;
  suggestion?: string;
}
