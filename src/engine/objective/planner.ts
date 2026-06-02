/**
 * @owner   src/engine/objective/planner.ts
 * @does    Routes natural-language goals through objective workflows and validates their command refs.
 * @needs   src/engine/objective/catalog.ts, src/engine/objective/media-playback.ts, src/engine/objective/delivery.ts
 * @feeds   src/commands/do.ts and future objective execution surfaces.
 * @breaks  Unvalidated workflow strategies can produce non-executable delivery specs.
 * @invariants All non-missing strategy commands must resolve in the live registry before delivery specs are emitted.
 * @side-effects none.
 * @perf    O(workflow count * intent length + strategy command refs).
 * @concurrency pure and reentrant after registry load.
 * @test    tests/unit/objective-compiler.test.ts, tests/unit/commands/do.test.ts
 * @stability experimental
 * @since   2026-06-01
 */

import { createRegistryObjectiveCatalog } from "./catalog.js";
import { buildObjectiveDeliverySpecTemplate } from "./delivery.js";
import { mediaPlaybackWorkflow } from "./media-playback.js";
import type {
  ObjectiveCapabilityGap,
  ObjectiveCommandCatalog,
  ObjectivePlan,
  ObjectiveStep,
  ObjectiveStrategy,
  ObjectiveWorkflow,
  ObjectiveWorkflowDraft,
} from "./types.js";

const OBJECTIVE_WORKFLOWS: readonly ObjectiveWorkflow[] = [
  mediaPlaybackWorkflow,
];

export function compileObjectivePlan(
  intent: string,
  catalog: ObjectiveCommandCatalog = createRegistryObjectiveCatalog(),
): ObjectivePlan | undefined {
  for (const workflow of OBJECTIVE_WORKFLOWS) {
    const draft = workflow.compile(intent);
    if (!draft) continue;
    return materializeObjectivePlan(draft, catalog);
  }
  return undefined;
}

function materializeObjectivePlan(
  draft: ObjectiveWorkflowDraft,
  catalog: ObjectiveCommandCatalog,
): ObjectivePlan {
  const validationGaps: ObjectiveCapabilityGap[] = [];
  const strategies = draft.strategies.map((strategy) =>
    validateStrategyCommands(strategy, catalog, validationGaps),
  );
  const plan: ObjectivePlan = {
    schema_version: "objective-plan.v1",
    objective: draft.objective,
    strategies,
    capability_gaps: [...draft.capability_gaps, ...validationGaps],
  };
  const deliverySpec = buildObjectiveDeliverySpecTemplate(plan);
  return deliverySpec
    ? { ...plan, delivery_spec_template: deliverySpec }
    : plan;
}

function validateStrategyCommands(
  strategy: ObjectiveStrategy,
  catalog: ObjectiveCommandCatalog,
  gaps: ObjectiveCapabilityGap[],
): ObjectiveStrategy {
  if (strategy.status === "missing") return strategy;

  const missingStep = strategyCommandRefs(strategy).find(
    (step) => !catalog.hasCommand(step.command),
  );
  if (!missingStep) return strategy;

  gaps.push({
    provider: strategy.provider,
    missing: missingStep.command,
    reason: `Objective strategy ${strategy.id} references an unregistered command: ${missingStep.command}.`,
  });
  return { ...strategy, status: "missing" };
}

function strategyCommandRefs(strategy: ObjectiveStrategy): ObjectiveStep[] {
  return [...strategy.steps, strategy.verification];
}
