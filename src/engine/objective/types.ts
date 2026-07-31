/**
 * @owner   src/engine/objective/types.ts
 * @does    Defines objective-level workflow contracts before command routing.
 * @needs   src/engine/delivery/types.ts, src/engine/delivery/spec.ts
 * @feeds   src/engine/objective/planner.ts, src/engine/objective/output.ts, src/commands/do.ts
 * @breaks  Weak objective contracts let stateful goals fall back to raw command search.
 * @invariants Objective plans are plan-only and must expose capability gaps instead of pretending missing app control works.
 * @side-effects none
 * @perf    type-only module.
 * @concurrency type-only module.
 * @test    tests/unit/objective-compiler.test.ts, tests/unit/commands/do.test.ts
 * @stability experimental
 * @since   2026-06-01
 */

import type { DeliveryEvidenceGate } from "../delivery/types.js";
import type { DeliveryOperatorSpec } from "../delivery/spec.js";

export type ObjectiveKind = "media.playback";

export type ObjectiveStrategySubstrate =
  | "native-api"
  | "desktop-cdp"
  | "desktop-ax"
  | "visual-coordinate";

export type ObjectiveStrategyStatus = "executable" | "partial" | "missing";

export interface ObjectivePlan {
  schema_version: "objective-plan.v1";
  objective: {
    id: string;
    kind: ObjectiveKind;
    goal: string;
    confidence: number;
    slots: Record<string, unknown>;
    evidence_gates: DeliveryEvidenceGate[];
  };
  strategies: ObjectiveStrategy[];
  capability_gaps: ObjectiveCapabilityGap[];
  delivery_spec_template?: DeliveryOperatorSpec;
}

export interface ObjectiveStrategy {
  id: string;
  label: string;
  provider: string;
  substrate: ObjectiveStrategySubstrate;
  status: ObjectiveStrategyStatus;
  priority: number;
  steps: ObjectiveStep[];
  verification: ObjectiveStep;
}

export interface ObjectiveStep {
  command: string;
  args?: Record<string, unknown>;
  purpose: string;
}

export interface ObjectiveCapabilityGap {
  provider: string;
  missing: string;
  reason: string;
}

export interface ObjectiveCommandCatalog {
  hasCommand(command: string): boolean;
}

export interface ObjectiveWorkflowDraft {
  objective: ObjectivePlan["objective"];
  strategies: ObjectiveStrategy[];
  capability_gaps: ObjectiveCapabilityGap[];
}

export interface ObjectiveWorkflow {
  id: ObjectiveKind;
  compile(intent: string): ObjectiveWorkflowDraft | undefined;
}
