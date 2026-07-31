/**
 * @owner   src/engine/objective/output.ts
 * @does    Builds agent-facing command candidates and next actions from objective plans.
 * @needs   src/engine/objective/catalog.ts, src/engine/objective/types.ts, src/output/envelope.ts
 * @feeds   src/commands/do.ts
 * @breaks  If next actions skip delivery.run, agents can bypass the real evidence loop.
 * @invariants Delivery spec execution is offered before direct commands; partial paths are labeled as partial.
 * @side-effects none.
 * @perf    O(strategy count).
 * @concurrency pure and reentrant.
 * @test    tests/unit/commands/do.test.ts
 * @stability experimental
 * @since   2026-06-01
 */

import type {
  AgentNextAction,
  AgentNextActionParam,
} from "../../output/envelope.js";
import { objectiveCommandToCli, parseObjectiveCommand } from "./catalog.js";
import type { ObjectivePlan } from "./types.js";

export function buildObjectiveDoPayload(
  intent: string,
  plan: ObjectivePlan,
  fallbackSearchCandidates: unknown[],
): Record<string, unknown> {
  return {
    intent,
    match: null,
    objective_plan: plan,
    catalog_candidates: buildObjectiveCatalogCandidates(plan),
    fallback_search_candidates: fallbackSearchCandidates,
    ...(plan.delivery_spec_template
      ? { delivery_spec_template: plan.delivery_spec_template }
      : {}),
  };
}

export function buildObjectiveNextActions(
  intent: string,
  plan: ObjectivePlan,
): AgentNextAction[] {
  const actions: AgentNextAction[] = [];
  if (plan.delivery_spec_template) {
    actions.push({
      command: "unicli delivery run <objective-delivery-spec.json>",
      description:
        "Execute the included delivery_spec_template and record evidence before claiming success",
    });
  }

  const firstRunnable = [...plan.strategies]
    .sort((left, right) => left.priority - right.priority)
    .find((strategy) => strategy.status !== "missing" && strategy.steps[0]);
  if (firstRunnable) {
    const firstStep = firstRunnable.steps[0];
    actions.push({
      command: objectiveCommandToCli(firstStep.command),
      description:
        firstRunnable.status === "executable"
          ? firstStep.purpose
          : `${firstStep.purpose} (partial ${firstRunnable.provider} path)`,
      ...(firstStep.args
        ? { params: argsToNextActionParams(firstStep.args) }
        : {}),
    });
    actions.push({
      command: objectiveCommandToCli(firstRunnable.verification.command),
      description: firstRunnable.verification.purpose,
    });
  }

  actions.push({
    command: `unicli search "${intent}"`,
    description:
      "Inspect the ranked operation and repair or re-plan if the objective plan is wrong",
  });
  return actions;
}

export function buildObjectiveCatalogCandidates(
  plan: ObjectivePlan,
): Array<Record<string, unknown>> {
  return plan.strategies.map((strategy) => {
    const firstStep = strategy.steps[0];
    const command = firstStep?.command ?? strategy.verification.command;
    const parsed = parseObjectiveCommand(command);
    return {
      site: parsed?.site ?? "unknown",
      command: parsed?.command ?? command,
      provider: strategy.provider,
      substrate: strategy.substrate,
      status: strategy.status,
      description: strategy.label,
      ...(firstStep?.args ? { args: firstStep.args } : {}),
    };
  });
}

function argsToNextActionParams(
  args: Record<string, unknown>,
): Record<string, AgentNextActionParam> {
  const params: Record<string, AgentNextActionParam> = {};
  for (const [name, value] of Object.entries(args)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      params[name] = { default: value };
    }
  }
  return params;
}
