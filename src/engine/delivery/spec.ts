/**
 * @owner   src/engine/delivery/spec.ts
 * @does    Builds explicit delivery operator spec templates from executable command matches.
 * @needs   src/engine/delivery/types.ts, src/types.ts
 * @feeds   src/commands/do.ts, src/commands/delivery.ts, tests/unit/delivery-cli.test.ts
 * @breaks  Bad template IDs or strategy kinds make do-to-delivery handoff ambiguous or non-executable.
 * @invariants generated specs contain no attempts or runs; execution remains owned by delivery.run.
 * @side-effects none
 * @perf    O(command metadata size).
 * @concurrency pure and reentrant.
 * @test    tests/unit/commands/do.test.ts, tests/unit/delivery-cli.test.ts
 * @stability experimental
 * @since   2026-05-31
 */

import type { AdapterType, TargetSurface } from "../../types.js";
import type {
  DeliveryAttempt,
  DeliveryEvidenceGate,
  DeliveryObjective,
  DeliveryStrategy,
  DeliveryStrategyKind,
} from "./types.js";
import type { RunId } from "../session/types.js";

const DEFAULT_TEMPLATE_GATES: DeliveryEvidenceGate[] = [
  { kind: "run_completed" },
  { kind: "required_evidence_type", evidence_type: "result-envelope" },
];

export interface DeliveryRunRef {
  run_id: RunId;
  strategy_id: string;
  id?: string;
  ordinal?: number;
}

export interface DeliveryOperatorSpec {
  objective: DeliveryObjective;
  strategies: DeliveryStrategy[];
  attempts: DeliveryAttempt[];
  runs: DeliveryRunRef[];
  recorded_at?: string;
}

export interface DeliverySpecCommandMatch {
  intent: string;
  site: string;
  command: string;
  description?: string;
  args?: Record<string, unknown>;
  adapter_path?: string;
  verify_command?: string;
  adapter_type?: AdapterType | string;
  target_surface?: TargetSurface | string;
  uses_browser?: boolean;
}

export function buildDeliveryOperatorSpecTemplate(
  match: DeliverySpecCommandMatch,
): DeliveryOperatorSpec {
  const site = match.site.trim();
  const command = match.command.trim();
  const objectiveId = `deliver-${slugPart(site)}-${slugPart(command)}`;
  const strategyKind = strategyKindForMatch(match);
  const strategyId = `${strategyKind}-${slugPart(site)}-${slugPart(command)}`;
  const strategy: DeliveryStrategy = {
    id: strategyId,
    kind: strategyKind,
    label: strategyLabel(match, site, command),
    priority: 10,
    command: `${site}.${command}`,
    ...(hasEntries(match.args) ? { args: match.args } : {}),
    ...(nonEmpty(match.adapter_path)
      ? { adapter_path: match.adapter_path }
      : {}),
    verify_command: match.verify_command ?? `unicli test ${site} ${command}`,
  };

  return {
    objective: {
      id: objectiveId,
      goal: nonEmpty(match.intent) ?? `Run ${site}.${command}`,
      evidence_gates: DEFAULT_TEMPLATE_GATES,
    },
    strategies: [strategy],
    attempts: [],
    runs: [],
  };
}

function strategyKindForMatch(
  match: DeliverySpecCommandMatch,
): DeliveryStrategyKind {
  if (match.uses_browser === true || match.adapter_type === "browser") {
    return "browser";
  }
  if (match.target_surface === "desktop" || match.adapter_type === "desktop") {
    return "desktop";
  }
  if (
    match.target_surface === "system" ||
    match.adapter_type === "bridge" ||
    match.adapter_type === "service"
  ) {
    return "local";
  }
  return "adapter";
}

function strategyLabel(
  match: DeliverySpecCommandMatch,
  site: string,
  command: string,
): string {
  const description = nonEmpty(match.description);
  return description
    ? `Run ${site}.${command}: ${description}`
    : `Run ${site}.${command}`;
}

function hasEntries(
  value: Record<string, unknown> | undefined,
): value is Record<string, unknown> {
  return value !== undefined && Object.keys(value).length > 0;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function slugPart(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "command"
  );
}
