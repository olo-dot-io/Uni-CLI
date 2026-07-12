/**
 * @owner       src::engine::repair::failure-classifier
 * @does        Distinguishes adapter-source drift from auth, network, rate-limit, and runtime failures.
 * @needs       v2 AgentError and the verified target identity
 * @feeds       repair failure envelope guidance and next actions
 * @breaks      Unknown codes remain explicit runtime diagnoses rather than triggering automatic edits.
 * @invariants  Auth, challenge, network, and rate-limit failures never recommend source mutation.
 * @side-effects None.
 * @perf        O(alternative count).
 * @concurrency Pure and reentrant.
 * @test        tests/unit/repair.test.ts
 * @stability   stable
 * @since       2026-04-07
 */

import type { AgentError } from "../../output/envelope.js";

export type RepairFailureType =
  | "adapter_drift"
  | "authentication"
  | "challenge"
  | "network"
  | "rate_limit"
  | "runtime";

export interface RepairDiagnosis {
  type: RepairFailureType;
  sourceRepairable: boolean;
  guidance: string;
  nextCommands: string[];
}

export function classifyRepairFailure(
  error: AgentError,
  target: {
    site: string;
    command: string;
    adapterPath: string;
    oracle: string;
  },
): RepairDiagnosis {
  const oracle = target.oracle;
  const inherited = error.alternatives ?? [];

  if (error.code === "auth_required" || error.code === "not_authenticated") {
    return {
      type: "authentication",
      sourceRepairable: false,
      guidance: `Authentication evidence is missing or expired; do not edit ${target.adapterPath}. Refresh auth, then rerun the oracle.`,
      nextCommands: [`unicli auth setup ${target.site}`, oracle, ...inherited],
    };
  }
  if (error.code === "challenge_required") {
    return {
      type: "challenge",
      sourceRepairable: false,
      guidance: `The site requires human verification; do not treat the challenge as adapter drift.`,
      nextCommands: [`unicli browser doctor --json`, oracle, ...inherited],
    };
  }
  if (error.code === "network_error") {
    return {
      type: "network",
      sourceRepairable: false,
      guidance: `Connectivity or proxy routing failed before adapter behavior could be verified; repair the network path, then rerun the oracle.`,
      nextCommands: [oracle, ...inherited],
    };
  }
  if (error.code === "rate_limited") {
    return {
      type: "rate_limit",
      sourceRepairable: false,
      guidance: `The upstream rate limit is transient evidence, not proof of source drift. Wait for the retry window, then rerun the oracle.`,
      nextCommands: [oracle, ...inherited],
    };
  }

  const repairableCodes = new Set([
    "selector_miss",
    "not_found",
    "api_error",
    "upstream_error",
    "empty_result",
    "unknown_action",
    "quarantined",
  ]);
  if (repairableCodes.has(error.code)) {
    return {
      type: "adapter_drift",
      sourceRepairable: true,
      guidance: `Inspect ${target.adapterPath}, make one evidence-backed source change, and rerun the exact oracle.`,
      nextCommands: [
        `unicli describe ${target.site} ${target.command}`,
        oracle,
        ...inherited,
      ],
    };
  }

  return {
    type: "runtime",
    sourceRepairable: false,
    guidance: `The failure is not established as adapter drift. Preserve the envelope and diagnose the owning runtime boundary before editing source.`,
    nextCommands: [
      `unicli describe ${target.site} ${target.command}`,
      oracle,
      ...inherited,
    ],
  };
}
