/**
 * Stable artifacts owned by the harness-evolution kernel.
 *
 * Proposal evidence, held-out evaluation, candidate execution, and promotion
 * remain separate so an upstream agent cannot turn its own completion claim
 * into a verified adapter update.
 */

import type {
  ExecutionOperator,
  OperationEffect,
  TargetSurface,
} from "../../types.js";
import type { Judge } from "../../commands/eval.js";
import type { PermissionProfile } from "../operation-policy.js";

export type EvolutionSessionState =
  | "draft"
  | "verified"
  | "rejected"
  | "promoted"
  | "rolled_back";

export interface EvolutionScope {
  domain?: string;
  model_affinity: string[];
  approved_network_origins: string[];
  permission_profile: PermissionProfile;
  target_surface?: TargetSurface | string;
  operation_effect?: OperationEffect;
  execution_operator?: ExecutionOperator;
}

export interface EvolutionComponent {
  kind: "adapter";
  id: string;
  site: string;
  command: string;
  source_path: string;
  source_tier: "packaged" | "user" | "runtime";
  editable_path: string;
  scope: EvolutionScope;
}

export interface EvidenceError {
  code: string;
  message?: string;
  step?: number;
  stage?: string;
  suggestion?: string;
  retryable?: boolean;
}

export type EvidenceFailureClass =
  | "adapter_behavior"
  | "caller_input"
  | "authentication_context"
  | "permission_policy"
  | "upstream_environment"
  | "verification_contract"
  | "unknown";

export interface EvidenceRunObservation {
  run_id: string;
  raw_trace_ref: string;
  command: string;
  status: string;
  args_hash?: string;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
  evidence_count: number;
  evidence_by_type: Record<string, number>;
  environment?: Record<string, unknown>;
  error?: EvidenceError;
  failure_class: EvidenceFailureClass;
}

export interface EvidencePacket {
  schema_version: "unicli.evidence-packet.v1";
  packet_id: string;
  created_at: string;
  provenance: {
    source: "local-run-store";
    content_trust: "untrusted";
    redaction: "applied";
    raw_trace_policy: "local-reference-only";
  };
  component: Pick<
    EvolutionComponent,
    "kind" | "id" | "site" | "command" | "source_path" | "source_tier"
  >;
  scope: EvolutionScope;
  sources: EvidenceRunObservation[];
  summary: {
    runs: number;
    completed: number;
    failed: number;
    failure_classes: Record<EvidenceFailureClass, number>;
    error_codes: Record<string, number>;
  };
}

export interface EvolutionArtifactRef {
  path: string;
  sha256: string;
}

export interface EvolutionPrediction {
  hypothesis: string;
  expected_fixes: string[];
  at_risk: string[];
}

export interface EvolutionVerificationAttempt {
  ordinal: number;
  verified_at: string;
  eligible: boolean;
  candidate: EvolutionArtifactRef;
  patch: EvolutionArtifactRef;
  report: EvolutionArtifactRef;
}

export interface EvolutionSession {
  schema_version: "unicli.evolution-session.v2";
  session_id: string;
  state: EvolutionSessionState;
  created_at: string;
  updated_at: string;
  component: EvolutionComponent;
  evidence: EvolutionArtifactRef & { packet_id: string };
  baseline: EvolutionArtifactRef;
  candidate: EvolutionArtifactRef;
  datasets: {
    proposal_run_ids: string[];
    validation_run_ids: string[];
    held_out_run_ids: string[];
    validation_eval_targets: string[];
    held_out_eval_targets: string[];
  };
  runtime: {
    run_root: string;
    cli_command: string;
    timeout_ms: number;
    allow_mutation_eval: boolean;
  };
  prediction?: EvolutionPrediction;
  attempts: EvolutionVerificationAttempt[];
  promotion?: {
    path: string;
    sha256: string;
    promoted_at: string;
    destination: string;
  };
}

export interface EvolutionCase {
  id: string;
  source: "run" | "eval";
  source_ref: string;
  command: string;
  args?: Record<string, string | number | boolean>;
  positional?: Array<string | number>;
  judges: Judge[];
}

export interface EvolutionCaseOutcome {
  id: string;
  source: EvolutionCase["source"];
  source_ref: string;
  command: string;
  passed: boolean;
  exit_code: number;
  duration_ms: number;
  failures: Array<{ judge: Judge["type"]; reason?: string }>;
}

export interface EvolutionScore {
  passed: number;
  total: number;
  pass_rate: number;
  duration_ms: number;
  token_usage: null;
  token_usage_available: false;
  cases: EvolutionCaseOutcome[];
}

export interface EvolutionSplitComparison {
  split: "validation" | "held-out";
  baseline: EvolutionScore;
  candidate: EvolutionScore;
  improvements: string[];
  regressions: string[];
  cost: {
    duration_delta_ms: number;
    duration_ratio: number | null;
    token_usage_available: false;
  };
}

export interface EvolutionVerificationReport {
  schema_version: "unicli.evolution-verification.v1";
  session_id: string;
  verified_at: string;
  component_id: string;
  baseline_sha256: string;
  candidate_sha256: string;
  attempt: number;
  candidate_path: string;
  patch_path: string;
  changed_lines: {
    added: number;
    removed: number;
  };
  prediction: EvolutionPrediction & {
    expected_fixed: string[];
    expected_missed: string[];
    at_risk_regressions: string[];
    unexpected_regressions: string[];
  };
  validation: EvolutionSplitComparison;
  held_out: EvolutionSplitComparison;
  decision: {
    eligible: boolean;
    candidate_changed: boolean;
    candidate_valid: boolean;
    prediction_satisfied: boolean;
    strict_validation_improvement: boolean;
    held_out_present: boolean;
    held_out_no_regression: boolean;
    reasons: string[];
  };
}

export interface EvolutionPromotionRecord {
  schema_version: "unicli.evolution-promotion.v1";
  session_id: string;
  component_id: string;
  promoted_at: string;
  destination: string;
  candidate_sha256: string;
  verification_path: string;
  previous_overlay: EvolutionArtifactRef | null;
  rollback_path: string | null;
}
