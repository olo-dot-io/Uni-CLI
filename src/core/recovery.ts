/**
 * @owner       src::core::recovery
 * @does        Define bounded same-primitive recovery policy and execution trace contracts.
 * @needs       No runtime dependency.
 * @feeds       provider profiles, compute dispatch, envelopes, route explanations, and evidence.
 * @breaks      Recovery that changes provider or modality under one route label invalidates target binding and replay safety.
 * @invariants  Automatic recovery is bounded; the selected provider, operator, perception, actuation, scope, and physical action remain unchanged.
 * @side-effects None.
 * @perf        Constant-size immutable metadata.
 * @concurrency Request-local values only.
 * @test        tests/unit/recovery.test.ts, tests/unit/compute-dispatch.test.ts, tests/unit/transport/routing.test.ts
 * @stability   experimental
 * @since       2026-07-30
 */

export type RecoveryStrategy = "none" | "same-primitive-retry";
export type RecoveryTrigger =
  | "pre-dispatch-transient"
  | "retryable-read-failure";

export interface RecoveryPolicy {
  strategy: RecoveryStrategy;
  max_attempts: 1 | 2;
  triggers: readonly RecoveryTrigger[];
  preserves: readonly [
    "provider",
    "operator",
    "perception",
    "actuation",
    "target_scope",
    "physical_action",
  ];
}

export interface RecoveryAttempt {
  attempt: number;
  trigger: RecoveryTrigger;
  reason: string;
}

export interface RecoveryTrace {
  strategy: RecoveryStrategy;
  attempts: number;
  recovered: boolean;
  provider: string;
  physical_action: string;
  failures: RecoveryAttempt[];
}

const PRESERVED_ROUTE_DIMENSIONS = [
  "provider",
  "operator",
  "perception",
  "actuation",
  "target_scope",
  "physical_action",
] as const;

export const NO_AUTOMATIC_RECOVERY: RecoveryPolicy = Object.freeze({
  strategy: "none",
  max_attempts: 1,
  triggers: Object.freeze([]) as readonly RecoveryTrigger[],
  preserves: PRESERVED_ROUTE_DIMENSIONS,
});

export const SAFE_READ_RECOVERY: RecoveryPolicy = Object.freeze({
  strategy: "same-primitive-retry",
  max_attempts: 2,
  triggers: Object.freeze([
    "retryable-read-failure",
  ] satisfies RecoveryTrigger[]),
  preserves: PRESERVED_ROUTE_DIMENSIONS,
});
