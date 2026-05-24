/**
 * @owner   src/engine/delivery/repair.ts
 * @does    Compiles delivery repair assessments into bounded adapter repair candidates.
 * @needs   src/engine/delivery/types.ts, src/engine/user-home.ts, node:path, node:url
 * @feeds   future repair command bridge and delivery operator surfaces.
 * @breaks  Over-broad candidate creation can turn auth, policy, or transient failures into unsafe code edits.
 * @invariants candidates require repair_adapter action, repairable diagnosis, owned adapter path, attempt id, strategy id, and verify command.
 * @side-effects none
 * @perf    O(1) over a completed delivery trajectory.
 * @concurrency pure and reentrant.
 * @test    tests/unit/engine-delivery-repair.test.ts
 * @stability experimental
 * @since   2026-05-24
 */

import type { DeliveryRepairCandidate, DeliveryTrajectory } from "./types.js";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { userHome } from "../user-home.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ADAPTERS_ROOT = resolve(
  MODULE_DIR,
  "..",
  "..",
  "..",
  "src",
  "adapters",
);

export function deliveryRepairCandidateFromTrajectory(
  trajectory: DeliveryTrajectory,
): DeliveryRepairCandidate | undefined {
  const assessment = trajectory.assessment;
  const diagnosis = assessment.diagnosis;
  const nextExperiment = trajectory.next_experiment;
  if (
    assessment.status !== "needs_repair" ||
    assessment.next_action !== "repair_adapter" ||
    nextExperiment?.action !== "repair_adapter" ||
    diagnosis?.repairable !== true
  ) {
    return undefined;
  }

  const adapterPath = diagnosis.adapter_path ?? nextExperiment.target;
  const verifyCommand =
    nextExperiment.verify_command ?? assessment.hypothesis?.verify_command;
  const attemptId = assessment.current_attempt_id;
  const strategyId = assessment.current_strategy_id;
  if (
    !attemptId ||
    !strategyId ||
    !verifyCommand ||
    !adapterPath ||
    !isAdapterFilePath(adapterPath)
  ) {
    return undefined;
  }

  const reason =
    assessment.hypothesis?.reason ?? diagnosis.suggestion ?? diagnosis.reason;
  return {
    schema_version: "1",
    objective_id: trajectory.objective_id,
    attempt_id: attemptId,
    strategy_id: strategyId,
    adapter_path: adapterPath,
    verify_command: verifyCommand,
    diagnosis_code: diagnosis.code,
    reason,
    ...(nextExperiment.command ? { command: nextExperiment.command } : {}),
    ...(typeof diagnosis.step === "number" ? { step: diagnosis.step } : {}),
    ...(diagnosis.suggestion ? { suggestion: diagnosis.suggestion } : {}),
  };
}

function isAdapterFilePath(path: string): boolean {
  const expandedPath = expandHome(path.trim());
  const normalizedPath = expandedPath.replaceAll("\\", "/");
  const hasAdapterExtension =
    normalizedPath.endsWith(".yaml") || normalizedPath.endsWith(".ts");
  if (
    !hasAdapterExtension ||
    normalizedPath.endsWith(".test.ts") ||
    hasParentSegment(normalizedPath)
  ) {
    return false;
  }
  if (isRelativePackageAdapterPath(normalizedPath)) return true;

  const absolutePath = resolve(expandedPath);
  const userAdaptersRoot = resolve(userHome(), ".unicli", "adapters");
  return (
    isPathInsideRoot(absolutePath, PACKAGE_ADAPTERS_ROOT) ||
    isPathInsideRoot(absolutePath, userAdaptersRoot)
  );
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? resolve(userHome(), path.slice(2)) : path;
}

function hasParentSegment(path: string): boolean {
  return path.split("/").includes("..");
}

function isRelativePackageAdapterPath(path: string): boolean {
  const relativePath = path.startsWith("./") ? path.slice(2) : path;
  return !isAbsolute(relativePath) && relativePath.startsWith("src/adapters/");
}

function isPathInsideRoot(path: string, root: string): boolean {
  const relation = relative(root, path);
  return (
    relation.length > 0 && !relation.startsWith("..") && !isAbsolute(relation)
  );
}
