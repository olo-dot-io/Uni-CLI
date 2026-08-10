/**
 * @owner       src::discovery::feasibility
 * @does        Intersect semantic command candidates with catalog-declared operator, effect, target, platform, and interaction constraints.
 * @needs       command contracts, live/core registries, operator/effect public types.
 * @feeds       search, do, MCP discovery, and future task planners.
 * @breaks      Presenting catalog compatibility as live provider readiness sends agents to unavailable executables or services.
 * @invariants  Hard requirements only remove contract-incompatible candidates; retrieval score never grants execution authority; runtime readiness is explicitly not evaluated here.
 * @side-effects Caches immutable command-contract projections until the registry version changes.
 * @perf        O(1) contract lookup after one projection; one feasibility check is O(1).
 * @concurrency Process-local cache replacement is synchronous and request independent.
 * @test        tests/unit/discovery-feasibility.test.ts, tests/unit/commands/do.test.ts, tests/unit/commands/search.test.ts
 * @stability   experimental
 * @since       2026-07-30
 */

import {
  buildCommandContract,
  buildCoreCommandContract,
  type CommandContract,
} from "../core/command-contract.js";
import { getCoreDiscoveryCommand } from "./core-catalog.js";
import { getRegistryVersion, resolveCommand } from "../registry.js";
import type {
  ExecutionOperator,
  OperationFamily,
  OperationEffect,
  OperatorTargetScope,
  TargetSurface,
} from "../types.js";
import type {
  CapabilityRequirements,
  InteractionImpact,
} from "./intent-plan.js";

export type {
  CapabilityRequirements,
  InteractionImpact,
} from "./intent-plan.js";

export interface CommandFeasibility {
  contract_compatible: boolean;
  compatibility: "compatible" | "unknown" | "incompatible";
  evidence_scope: "catalog_contract";
  runtime_readiness: "not_evaluated";
  command: string;
  requirements: CapabilityRequirements;
  contract?: CommandFeasibilityProfile;
  rejected_by: string[];
  uncertain_by: string[];
}

export interface CommandFeasibilityProfile {
  operation_family: OperationFamily;
  operation_family_source: CommandContract["operation"]["source"];
  operation_family_confidence: CommandContract["operation"]["confidence"];
  operator: ExecutionOperator;
  operator_source: CommandContract["execution"]["operator_source"];
  operator_confidence: CommandContract["execution"]["operator_confidence"];
  target_surface: TargetSurface;
  target_surface_source: CommandContract["effect"]["target_surface_source"];
  target_surface_confidence: CommandContract["effect"]["target_surface_confidence"];
  target_scope: OperatorTargetScope;
  target_scope_source: CommandContract["execution"]["operator_source"];
  target_scope_confidence: CommandContract["execution"]["operator_confidence"];
  effect: OperationEffect;
  effect_source: "declared" | "heuristic" | "default";
  effect_confidence: "high" | "medium" | "low";
  interaction_impact: InteractionImpact;
  coordinate_actuation: boolean;
  platforms?: NodeJS.Platform[];
}

let cachedRegistryVersion = -1;
let contractCache = new Map<string, CommandContract | null>();

export function evaluateCommandFeasibility(
  site: string,
  command: string,
  requirements: CapabilityRequirements,
): CommandFeasibility {
  const contract = commandContract(site, command);
  if (!contract) {
    return {
      contract_compatible: true,
      compatibility:
        Object.keys(requirements).length === 0 ? "compatible" : "unknown",
      evidence_scope: "catalog_contract",
      runtime_readiness: "not_evaluated",
      command: `${site} ${command}`,
      requirements,
      rejected_by: [],
      uncertain_by:
        Object.keys(requirements).length === 0
          ? []
          : ["command contract is unavailable"],
    };
  }
  return evaluateFeasibilityProfile(
    site,
    command,
    commandFeasibilityProfile(contract),
    requirements,
  );
}

export function evaluateFeasibilityProfile(
  site: string,
  command: string,
  profile: CommandFeasibilityProfile,
  requirements: CapabilityRequirements,
): CommandFeasibility {
  const rejectedBy: string[] = [];
  const uncertainBy: string[] = [];
  if (
    requirements.required_sites &&
    requirements.required_sites.length > 0 &&
    !requirements.required_sites.includes(site)
  ) {
    rejectedBy.push(
      `site requires one of ${requirements.required_sites.join(", ")}, candidate uses ${site}`,
    );
  }
  if (
    requirements.operation_family &&
    profile.operation_family !== requirements.operation_family
  ) {
    const reason = `operation requires ${requirements.operation_family}, candidate projects ${profile.operation_family} from ${profile.operation_family_source}`;
    rejectedBy.push(reason);
  }
  if (requirements.operator && profile.operator !== requirements.operator) {
    const reason = `operator requires ${requirements.operator}, candidate projects ${profile.operator} from ${profile.operator_source}`;
    rejectedBy.push(reason);
  }
  if (requirements.forbidden_operators?.includes(profile.operator)) {
    rejectedBy.push(`operator ${profile.operator} is explicitly forbidden`);
  }
  if (
    requirements.allow_browser === false &&
    (profile.operator === "browser-protocol" ||
      profile.operator === "browser-semantic")
  ) {
    rejectedBy.push(
      `browser lifecycle is forbidden but candidate uses ${profile.operator}`,
    );
  }
  if (
    requirements.target_surface &&
    profile.target_surface !== requirements.target_surface
  ) {
    const reason = `target surface requires ${requirements.target_surface}, candidate projects ${profile.target_surface} from ${profile.target_surface_source}`;
    rejectedBy.push(reason);
  }
  if (
    requirements.target_scope &&
    profile.target_scope !== requirements.target_scope
  ) {
    const reason = `target scope requires ${requirements.target_scope}, candidate projects ${profile.target_scope} from ${profile.target_scope_source}`;
    rejectedBy.push(reason);
  }
  if (requirements.effect && profile.effect !== requirements.effect) {
    const reason = `effect requires ${requirements.effect}, candidate projects ${profile.effect} from ${profile.effect_source}`;
    rejectedBy.push(reason);
  }
  if (
    requirements.max_interaction_impact &&
    interactionRank(profile.interaction_impact) >
      interactionRank(requirements.max_interaction_impact)
  ) {
    rejectedBy.push(
      `interaction impact ${profile.interaction_impact} exceeds ${requirements.max_interaction_impact}`,
    );
  }
  const allowCoordinateActuation = requirements.allow_coordinate_actuation;
  if (
    allowCoordinateActuation === false &&
    profile.coordinate_actuation === true
  ) {
    rejectedBy.push("visual-coordinate execution was not authorized");
  }
  if (
    requirements.platform &&
    profile.platforms &&
    !profile.platforms.includes(requirements.platform)
  ) {
    rejectedBy.push(
      `platform requires ${requirements.platform}, candidate supports ${profile.platforms.join(", ")}`,
    );
  }

  return {
    contract_compatible: rejectedBy.length === 0,
    compatibility:
      rejectedBy.length > 0
        ? "incompatible"
        : uncertainBy.length > 0
          ? "unknown"
          : "compatible",
    evidence_scope: "catalog_contract",
    runtime_readiness: "not_evaluated",
    command: `${site} ${command}`,
    requirements,
    contract: profile,
    rejected_by: rejectedBy,
    uncertain_by: uncertainBy,
  };
}

export function commandFeasibilityProfile(
  contract: CommandContract,
): CommandFeasibilityProfile {
  const platforms = declaredPlatforms(contract);
  return {
    operation_family: contract.operation.family,
    operation_family_source: contract.operation.source,
    operation_family_confidence: contract.operation.confidence,
    operator: contract.execution.operator,
    operator_source: contract.execution.operator_source,
    operator_confidence: contract.execution.operator_confidence,
    target_surface: contract.effect.target_surface,
    target_surface_source: contract.effect.target_surface_source,
    target_surface_confidence: contract.effect.target_surface_confidence,
    target_scope: contract.execution.target_scope,
    target_scope_source: contract.execution.operator_source,
    target_scope_confidence: contract.execution.operator_confidence,
    effect: contract.effect.operation_effect,
    effect_source: contract.effect.effect_source,
    effect_confidence: contract.effect.effect_confidence,
    interaction_impact: contract.execution.interaction_impact,
    coordinate_actuation: contract.execution.coordinate_actuation,
    ...(platforms ? { platforms } : {}),
  };
}

function commandContract(
  site: string,
  command: string,
): CommandContract | undefined {
  const version = getRegistryVersion();
  if (cachedRegistryVersion !== version) {
    cachedRegistryVersion = version;
    contractCache = new Map();
  }
  const id = `${site}/${command}`;
  const cached = contractCache.get(id);
  if (cached !== undefined) return cached ?? undefined;

  const resolved = resolveCommand(site, command);
  const contract = resolved
    ? buildCommandContract({
        adapter: resolved.adapter,
        commandName: command,
        command: resolved.command,
      })
    : (() => {
        const core = getCoreDiscoveryCommand(site, command);
        return core ? buildCoreCommandContract({ command: core }) : undefined;
      })();
  contractCache.set(id, contract ?? null);
  return contract;
}

function declaredPlatforms(
  contract: CommandContract,
): NodeJS.Platform[] | undefined {
  const capability = contract.repair.minimum_capability ?? "";
  if (
    contract.identity.site === "macos" ||
    capability.startsWith("desktop-ax.")
  ) {
    return ["darwin"];
  }
  if (capability.startsWith("desktop-uia.")) return ["win32"];
  if (capability.startsWith("desktop-atspi.")) return ["linux"];
  return undefined;
}

function interactionRank(impact: InteractionImpact): number {
  switch (impact) {
    case "background":
      return 0;
    case "target-scoped":
      return 1;
    case "foreground":
      return 2;
  }
}
