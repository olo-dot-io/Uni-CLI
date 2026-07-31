/**
 * @owner   src/engine/objective/delivery.ts
 * @does    Compiles objective plans into executable delivery spec templates.
 * @needs   src/engine/delivery/spec.ts, src/engine/objective/types.ts
 * @feeds   src/engine/objective/planner.ts, src/commands/do.ts
 * @breaks  Including partial or missing strategies would make delivery.run execute known-incomplete app paths.
 * @invariants Only executable objective strategies become delivery strategies; gaps stay reviewable metadata.
 * @side-effects none.
 * @perf    O(strategy count).
 * @concurrency pure and reentrant.
 * @test    tests/unit/objective-compiler.test.ts, tests/unit/commands/do.test.ts
 * @stability experimental
 * @since   2026-06-01
 */

import type { DeliveryOperatorSpec, DeliveryRunRef } from "../delivery/spec.js";
import type {
  DeliveryAttempt,
  DeliveryStrategy,
  DeliveryStrategyKind,
} from "../delivery/types.js";
import { objectiveCommandToCli } from "./catalog.js";
import type { ObjectivePlan, ObjectiveStrategy } from "./types.js";

export function buildObjectiveDeliverySpecTemplate(
  plan: ObjectivePlan,
): DeliveryOperatorSpec | undefined {
  const strategies = plan.strategies
    .filter((strategy) => strategy.status === "executable")
    .map(strategyToDeliveryStrategy);
  if (strategies.length === 0) return undefined;

  return {
    objective: {
      id: plan.objective.id,
      goal: plan.objective.goal,
      evidence_gates: plan.objective.evidence_gates,
      attempt_budget: {
        max_attempts: Math.max(strategies.length, 1),
        max_attempts_per_strategy: 1,
      },
    },
    strategies,
    attempts: [] satisfies DeliveryAttempt[],
    runs: [] satisfies DeliveryRunRef[],
  };
}

function strategyToDeliveryStrategy(
  strategy: ObjectiveStrategy,
): DeliveryStrategy {
  const firstStep = strategy.steps[0];
  return {
    id: strategy.id,
    kind: deliveryStrategyKind(strategy),
    label: strategy.label,
    priority: strategy.priority,
    ...(firstStep
      ? {
          command: firstStep.command,
          ...(firstStep.args ? { args: firstStep.args } : {}),
        }
      : {}),
    verify_command: objectiveCommandToCli(strategy.verification.command),
  };
}

function deliveryStrategyKind(
  strategy: ObjectiveStrategy,
): DeliveryStrategyKind {
  switch (strategy.substrate) {
    case "desktop-ax":
    case "desktop-cdp":
      return "desktop";
    case "visual-coordinate":
      return "manual";
    case "native-api":
      return "adapter";
  }
}
