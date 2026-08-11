import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import yaml from "js-yaml";
import { formatPatch, structuredPatch } from "diff";

import { normalizeYamlAdapterDocument } from "../../core/yaml-adapter.js";
import { getBuiltinDirs } from "../../discovery/loader.js";
import type { AdapterCommand } from "../../types.js";
import type { YamlAdapterNormalization } from "../../core/yaml-adapter.js";
import type { RunStore } from "../session/store.js";
import {
  createEvolutionSessionId,
  evolutionSessionPaths,
  initializeEvolutionSession,
  sha256Text,
  writeEvolutionSession,
  writePrivateJson,
  writePrivateText,
  type EvolutionStore,
} from "./store.js";
import { distillRunEvidence } from "./distill.js";
import { EvolutionError } from "./error.js";
import type {
  EvolutionComponent,
  EvolutionPrediction,
  EvolutionScope,
  EvolutionSession,
} from "./types.js";

const MAX_ADAPTER_BYTES = 256 * 1024;

export async function createAdapterEvolutionSession(input: {
  evolutionStore: EvolutionStore;
  runStore: RunStore;
  site: string;
  command: string;
  adapterCommand: AdapterCommand;
  proposalRunIds: string[];
  validationRunIds?: string[];
  heldOutRunIds?: string[];
  validationEvalTargets?: string[];
  heldOutEvalTargets?: string[];
  modelAffinity?: string[];
  domain?: string;
  permissionProfile?: string;
  candidatePath?: string;
  sessionId?: string;
  cliCommand?: string;
  timeoutMs?: number;
  allowMutationEval?: boolean;
  prediction?: EvolutionPrediction;
  createdAt?: string;
}): Promise<EvolutionSession> {
  const proposalRunIds = unique(input.proposalRunIds);
  const validationRunIds = unique(input.validationRunIds ?? []);
  const heldOutRunIds = unique(input.heldOutRunIds ?? []);
  assertDisjointRunSplits(proposalRunIds, validationRunIds, heldOutRunIds);
  const sourcePath = resolveAdapterFile(
    input.site,
    input.command,
    input.adapterCommand.adapter_path,
  );
  const sourceContent = await readAdapterText(sourcePath, "source_not_found");
  const baselineAdapter = parseAdapterYaml(
    sourceContent,
    input.command,
    sourcePath,
  );

  const candidateContent = input.candidatePath
    ? await readAdapterText(resolve(input.candidatePath), "candidate_invalid")
    : sourceContent;
  const candidateAdapter = parseAdapterYaml(
    candidateContent,
    input.command,
    input.candidatePath ?? sourcePath,
  );
  assertEvolutionScopeUnchanged(
    baselineAdapter,
    candidateAdapter,
    input.candidatePath ?? sourcePath,
  );
  const prediction = normalizeEvolutionPrediction(input.prediction);
  if (candidateContent !== sourceContent && !prediction) {
    throw new EvolutionError(
      "candidate_invalid",
      "a changed candidate requires a falsifiable hypothesis and expected fixes",
      input.candidatePath,
    );
  }

  const createdAt = input.createdAt ?? new Date().toISOString();
  const sessionId = input.sessionId ?? createEvolutionSessionId();
  const paths = evolutionSessionPaths(
    input.evolutionStore,
    sessionId,
    input.site,
    input.command,
  );
  const domain = input.domain ?? input.adapterCommand.domain;
  const scope: EvolutionScope = {
    ...(domain ? { domain } : {}),
    model_affinity: unique(input.modelAffinity ?? []),
    permission_profile: input.permissionProfile ?? "open",
    ...(input.adapterCommand.target_surface
      ? { target_surface: input.adapterCommand.target_surface }
      : {}),
    ...(input.adapterCommand.operation_effect
      ? { operation_effect: input.adapterCommand.operation_effect }
      : {}),
    ...(input.adapterCommand.execution_operator
      ? { execution_operator: input.adapterCommand.execution_operator }
      : {}),
  };
  const sourceTier = input.adapterCommand.source_tier ?? "runtime";
  const component: EvolutionComponent = {
    kind: "adapter",
    id: `adapter:${input.site}.${input.command}`,
    site: input.site,
    command: input.command,
    source_path: sourcePath,
    source_tier: sourceTier,
    editable_path: paths.candidate_file,
    scope,
  };
  const evidence = await distillRunEvidence({
    store: input.runStore,
    runIds: proposalRunIds,
    component,
    scope,
    createdAt,
  });

  await initializeEvolutionSession(paths);
  await writePrivateText(paths.baseline_file, sourceContent);
  await writePrivateText(paths.candidate_file, candidateContent);
  await writePrivateJson(paths.evidence, evidence);

  const session: EvolutionSession = {
    schema_version: "unicli.evolution-session.v1",
    session_id: sessionId,
    state: "draft",
    created_at: createdAt,
    updated_at: createdAt,
    component,
    evidence: {
      packet_id: evidence.packet_id,
      path: paths.evidence,
      sha256: sha256Text(`${JSON.stringify(evidence, null, 2)}\n`),
    },
    baseline: {
      path: paths.baseline_file,
      sha256: sha256Text(sourceContent),
    },
    candidate: {
      path: paths.candidate_file,
      sha256: sha256Text(candidateContent),
    },
    datasets: {
      proposal_run_ids: proposalRunIds,
      validation_run_ids: validationRunIds,
      held_out_run_ids: heldOutRunIds,
      validation_eval_targets: unique(input.validationEvalTargets ?? []),
      held_out_eval_targets: unique(input.heldOutEvalTargets ?? []),
    },
    runtime: {
      run_root: input.runStore.rootDir,
      cli_command: input.cliCommand ?? process.env.UNICLI_BIN ?? "unicli",
      timeout_ms: input.timeoutMs ?? 30_000,
      allow_mutation_eval: input.allowMutationEval === true,
    },
    ...(prediction ? { prediction } : {}),
  };
  await writeEvolutionSession(input.evolutionStore, session);
  return session;
}

export function normalizeEvolutionPrediction(
  value?: EvolutionPrediction,
): EvolutionPrediction | undefined {
  if (!value) return undefined;
  const hypothesis = value.hypothesis.trim();
  const expectedFixes = unique(value.expected_fixes);
  const atRisk = unique(value.at_risk);
  if (!hypothesis || expectedFixes.length === 0) {
    throw new EvolutionError(
      "candidate_invalid",
      "a prediction requires a hypothesis and at least one expected fix",
    );
  }
  const overlap = expectedFixes.find((entry) => atRisk.includes(entry));
  if (overlap) {
    throw new EvolutionError(
      "candidate_invalid",
      `prediction target appears in expected fixes and at-risk cases: ${overlap}`,
    );
  }
  return {
    hypothesis,
    expected_fixes: expectedFixes,
    at_risk: atRisk,
  };
}

export function parseAdapterYaml(
  content: string,
  command: string,
  path: string,
): Extract<YamlAdapterNormalization, { ok: true }> {
  if (Buffer.byteLength(content, "utf-8") > MAX_ADAPTER_BYTES) {
    throw new EvolutionError(
      "candidate_invalid",
      `adapter candidate exceeds ${MAX_ADAPTER_BYTES} bytes`,
      path,
    );
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(content, {
      schema: yaml.CORE_SCHEMA,
      filename: path,
    });
  } catch (error) {
    throw new EvolutionError(
      "candidate_invalid",
      `failed to parse adapter candidate: ${error instanceof Error ? error.message : String(error)}`,
      path,
    );
  }
  const normalized = normalizeYamlAdapterDocument(
    parsed,
    command,
    path,
    "user",
  );
  if (!normalized.ok) {
    throw new EvolutionError(
      "candidate_invalid",
      `invalid adapter candidate: ${normalized.error}`,
      path,
    );
  }
  return normalized;
}

/**
 * Keep an adapter candidate inside the authorization scope that was verified
 * when the session was created. Endpoint, selector, extraction, and pipeline
 * repairs remain editable; policy and substrate declarations require a new
 * session and an explicit review path.
 */
export function assertEvolutionScopeUnchanged(
  baseline: Extract<YamlAdapterNormalization, { ok: true }>,
  candidate: Extract<YamlAdapterNormalization, { ok: true }>,
  path: string,
): void {
  const baselineScope = evolutionScopeSignature(baseline);
  const candidateScope = evolutionScopeSignature(candidate);
  const changed = Object.keys(baselineScope).filter(
    (field) =>
      JSON.stringify(baselineScope[field]) !==
      JSON.stringify(candidateScope[field]),
  );
  if (changed.length > 0) {
    throw new EvolutionError(
      "candidate_invalid",
      `adapter candidate changes evolution scope fields: ${changed.join(", ")}`,
      path,
    );
  }
}

function evolutionScopeSignature(
  normalized: Extract<YamlAdapterNormalization, { ok: true }>,
): Record<string, unknown> {
  const { document, validated } = normalized;
  return {
    type: document.type ?? null,
    strategy: document.strategy ?? null,
    browser: document.browser ?? null,
    browser_session: document.browserSession ?? null,
    binary: document.binary ?? null,
    executables: sorted(validated.executables),
    passthrough: document.passthrough ?? null,
    auto_install: document.autoInstall ?? null,
    auth: document.auth ?? null,
    auth_cookies: sorted(document.auth_cookies),
    auth_requirement: validated.auth_requirement ?? null,
    operation_effect: validated.operation_effect ?? null,
    execution_operator: validated.execution_operator ?? null,
    operation_family: validated.operation_family ?? null,
    idempotency: validated.idempotency ?? null,
    target_surface: document.target_surface ?? null,
    capabilities: sorted(validated.capabilities),
    minimum_capability: validated.minimum_capability,
    trust: validated.trust,
    confidentiality: validated.confidentiality,
  };
}

function sorted(values: string[] | undefined): string[] {
  return [...(values ?? [])].sort();
}

export function createUnifiedAdapterDiff(input: {
  baseline: string;
  candidate: string;
  baselineLabel: string;
  candidateLabel: string;
}): { patch: string; added: number; removed: number } {
  const patch = structuredPatch(
    input.baselineLabel,
    input.candidateLabel,
    input.baseline,
    input.candidate,
  );
  const lines = patch.hunks.flatMap((hunk) => hunk.lines);
  return {
    patch: formatPatch(patch),
    added: lines.filter((line) => line.startsWith("+")).length,
    removed: lines.filter((line) => line.startsWith("-")).length,
  };
}

function resolveAdapterFile(
  site: string,
  command: string,
  declaredPath?: string,
): string {
  const candidates: string[] = [];
  if (declaredPath) {
    const expanded = declaredPath.startsWith("~/")
      ? join(process.env.HOME ?? "", declaredPath.slice(2))
      : declaredPath;
    candidates.push(isAbsolute(expanded) ? expanded : resolve(expanded));
  }
  const builtin = getBuiltinDirs().yamlDir;
  candidates.push(
    join(builtin, site, `${command}.yaml`),
    join(builtin, site, `${command}.yml`),
  );
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new EvolutionError(
      "source_not_found",
      `adapter source file not found for ${site}.${command}`,
      declaredPath,
    );
  }
  if (!found.endsWith(".yaml") && !found.endsWith(".yml")) {
    throw new EvolutionError(
      "adapter_not_editable",
      `1.2.0 evolution sessions require a YAML adapter: ${found}`,
      found,
    );
  }
  return found;
}

async function readAdapterText(
  path: string,
  code: "source_not_found" | "candidate_invalid",
): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    throw new EvolutionError(
      code,
      `failed to read adapter file: ${error instanceof Error ? error.message : String(error)}`,
      path,
    );
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function assertDisjointRunSplits(
  proposal: string[],
  validation: string[],
  heldOut: string[],
): void {
  const owners = new Map<string, string>();
  for (const [split, runIds] of [
    ["proposal", proposal],
    ["validation", validation],
    ["held-out", heldOut],
  ] as const) {
    for (const runId of runIds) {
      const previous = owners.get(runId);
      if (previous) {
        throw new EvolutionError(
          "candidate_invalid",
          `run ${runId} appears in both ${previous} and ${split}; evolution data splits must be disjoint`,
        );
      }
      owners.set(runId, split);
    }
  }
}
