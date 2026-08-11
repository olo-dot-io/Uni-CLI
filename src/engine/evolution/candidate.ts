import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import yaml from "js-yaml";
import { formatPatch, structuredPatch } from "diff";

import { findEvalFiles } from "../../commands/eval.js";
import { normalizeYamlAdapterDocument } from "../../core/yaml-adapter.js";
import { buildArgumentJsonSchema } from "../../core/argument-schema.js";
import { getBuiltinDirs } from "../../discovery/loader.js";
import type { AdapterCommand } from "../../types.js";
import type { YamlAdapterNormalization } from "../../core/yaml-adapter.js";
import type { RunStore } from "../session/store.js";
import { resolvePermissionProfile } from "../operation-policy.js";
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
  approvedNetworkOrigins?: string[];
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
    input.approvedNetworkOrigins,
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
    approved_network_origins: normalizeApprovedOrigins(
      input.approvedNetworkOrigins ?? [],
    ),
    permission_profile: resolvePermissionProfile(input.permissionProfile),
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
  assertRepairableProposalEvidence(evidence);

  await initializeEvolutionSession(paths);
  await writePrivateText(paths.baseline_file, sourceContent);
  await writePrivateText(paths.candidate_file, candidateContent);
  const evidenceSha256 = await writePrivateJson(paths.evidence, evidence);

  const session: EvolutionSession = {
    schema_version: "unicli.evolution-session.v2",
    session_id: sessionId,
    state: "draft",
    created_at: createdAt,
    updated_at: createdAt,
    component,
    evidence: {
      packet_id: evidence.packet_id,
      path: paths.evidence,
      sha256: evidenceSha256,
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
      validation_eval_targets: normalizeEvolutionEvalTargets(
        input.validationEvalTargets ?? [],
      ),
      held_out_eval_targets: normalizeEvolutionEvalTargets(
        input.heldOutEvalTargets ?? [],
      ),
    },
    runtime: {
      run_root: resolve(input.runStore.rootDir),
      cli_command: input.cliCommand ?? process.env.UNICLI_BIN ?? "unicli",
      timeout_ms: input.timeoutMs ?? 30_000,
      allow_mutation_eval: input.allowMutationEval === true,
    },
    ...(prediction ? { prediction } : {}),
    attempts: [],
  };
  await writeEvolutionSession(input.evolutionStore, session);
  return session;
}

export function normalizeEvolutionEvalTargets(values: string[]): string[] {
  return unique(
    unique(values).flatMap((value) => {
      const matches = findEvalFiles([value]);
      if (matches.length > 0) return matches;
      return [
        isAbsolute(value) ||
        value.startsWith(".") ||
        value.includes("\\") ||
        /\.ya?ml$/i.test(value) ||
        existsSync(resolve(value))
          ? resolve(value)
          : value,
      ];
    }),
  );
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
  approvedNetworkOrigins: string[] = [],
): void {
  const baselineScope = evolutionScopeSignature(baseline);
  const candidateScope = evolutionScopeSignature(candidate);
  const approvedOrigins = new Set(
    normalizeApprovedOrigins(approvedNetworkOrigins),
  );
  const changed = Object.keys(baselineScope).filter((field) => {
    if (field === "network_origins") {
      const baselineOrigins = new Set(baselineScope[field] as string[]);
      return (candidateScope[field] as string[]).some(
        (origin) =>
          !baselineOrigins.has(origin) && !approvedOrigins.has(origin),
      );
    }
    return (
      JSON.stringify(baselineScope[field]) !==
      JSON.stringify(candidateScope[field])
    );
  });
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
    identity_contract: {
      site: document.site ?? null,
      name: document.name ?? null,
      description: document.description ?? null,
      domain: document.domain ?? null,
    },
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
    network_origins: networkOrigins(document),
    network_methods: {
      document: document.method?.toUpperCase() ?? null,
      pipeline: pipelineActionConfigs(document.pipeline, [
        "fetch",
        "fetch_text",
      ]).map(({ action, config }) => ({
        action,
        method:
          isRecord(config) && typeof config.method === "string"
            ? config.method.toUpperCase()
            : "GET",
      })),
    },
    request_headers: canonicalJsonValue({
      document: document.headers ?? null,
      pipeline: nestedFieldValues(document.pipeline, "headers"),
    }),
    pipeline_actions: pipelineActionShape(document.pipeline),
    exec_contract: canonicalJsonValue(
      pipelineActionConfigs(document.pipeline, ["exec"]).map(
        ({ config }) => config,
      ),
    ),
    input_contract: {
      schema: canonicalJsonValue(
        buildArgumentJsonSchema(
          [...(normalized.command.adapterArgs ?? [])].sort((left, right) =>
            left.name.localeCompare(right.name),
          ),
        ),
      ),
      positional: (normalized.command.adapterArgs ?? [])
        .filter((argument) => argument.positional)
        .map((argument) => argument.name),
    },
    output_contract: {
      output: canonicalJsonValue(normalized.command.output ?? null),
      columns: normalized.command.columns ?? [],
      default_format: normalized.command.defaultFormat ?? null,
      stream: normalized.command.stream ?? false,
      paginated: normalized.command.paginated ?? false,
    },
  };
}

function networkOrigins(
  document: Extract<YamlAdapterNormalization, { ok: true }>["document"],
): string[] {
  const origins = new Set<string>();
  const add = (value: unknown, domain = false): void => {
    if (typeof value !== "string" || value.trim().length === 0) return;
    const raw = value.trim();
    if (!domain && !/^https?:\/\//iu.test(raw)) return;
    try {
      origins.add(
        new URL(domain && !raw.includes("://") ? `https://${raw}` : raw).origin,
      );
    } catch {
      // REASON: templated URLs are not valid WHATWG URLs before argument
      // resolution; retain their static authority for scope comparison.
      const authority = /^https?:\/\/[^/]+/iu.exec(raw)?.[0];
      if (authority) origins.add(authority.toLowerCase());
    }
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === "object") {
      Object.values(value).forEach(visit);
      return;
    }
    add(value);
  };
  add(document.domain, true);
  add(document.base);
  add(document.url);
  add(document.navigate);
  visit(document.pipeline);
  return [...origins].sort();
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
  );
}

const PIPELINE_SIBLING_KEYS = new Set([
  "then",
  "else",
  "merge",
  "retry",
  "backoff",
]);

function pipelineActionShape(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((step) => {
    if (!isRecord(step)) return null;
    const action = Object.keys(step).find(
      (key) => !PIPELINE_SIBLING_KEYS.has(key),
    );
    if (!action) return null;
    const config = step[action];
    return {
      action,
      ...(action === "if"
        ? {
            then_actions: pipelineActionShape(step.then),
            else_actions: pipelineActionShape(step.else),
          }
        : {}),
      ...(action === "each" && isRecord(config)
        ? { do: pipelineActionShape(config.do) }
        : {}),
      ...(action === "parallel"
        ? { branches: pipelineActionShape(config) }
        : {}),
    };
  });
}

function pipelineActionConfigs(
  value: unknown,
  actions: string[],
): Array<{ action: string; config: unknown }> {
  const matches: Array<{ action: string; config: unknown }> = [];
  visitNested(value, (entry) => {
    for (const action of actions) {
      if (Object.hasOwn(entry, action)) {
        matches.push({ action, config: entry[action] });
      }
    }
  });
  return matches;
}

function nestedFieldValues(value: unknown, field: string): unknown[] {
  const values: unknown[] = [];
  visitNested(value, (entry) => {
    if (Object.hasOwn(entry, field)) values.push(entry[field]);
  });
  return values;
}

function visitNested(
  value: unknown,
  visitor: (entry: Record<string, unknown>) => void,
): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => visitNested(entry, visitor));
    return;
  }
  if (!isRecord(value)) return;
  visitor(value);
  Object.values(value).forEach((entry) => visitNested(entry, visitor));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function normalizeApprovedOrigins(values: string[]): string[] {
  return [
    ...new Set(
      unique(values).map((value) => {
        try {
          const url = new URL(
            value.includes("://") ? value : `https://${value}`,
          );
          if (
            !/^https?:$/u.test(url.protocol) ||
            url.username ||
            url.password
          ) {
            throw new Error("unsupported origin");
          }
          return url.origin;
        } catch {
          throw new EvolutionError(
            "candidate_invalid",
            `invalid approved network origin: ${value}`,
          );
        }
      }),
    ),
  ].sort();
}

function assertRepairableProposalEvidence(
  evidence: Awaited<ReturnType<typeof distillRunEvidence>>,
): void {
  const invalid = evidence.sources.filter(
    (source) =>
      source.status !== "failed" || source.failure_class !== "adapter_behavior",
  );
  if (invalid.length === 0) return;
  throw new EvolutionError(
    "candidate_invalid",
    `proposal evidence contains failures outside the adapter repair boundary; rejected runs: ${invalid
      .map((source) => `${source.run_id} (${source.failure_class})`)
      .join(", ")}`,
  );
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
