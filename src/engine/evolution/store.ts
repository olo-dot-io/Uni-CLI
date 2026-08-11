import { chmod, mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";

import { userDataRoot } from "../user-home.js";
import { writeFileTransactionally } from "../transactional-file.js";
import type { EvolutionSession } from "./types.js";
import { EvolutionError } from "./error.js";

export interface EvolutionStore {
  root_dir: string;
}

export interface EvolutionSessionPaths {
  root: string;
  manifest: string;
  evidence: string;
  baseline_overlay: string;
  baseline_file: string;
  candidate_overlay: string;
  candidate_file: string;
  patch: string;
  verification: string;
  promotion: string;
  rollback: string;
  baseline_runs: string;
  candidate_runs: string;
}

export function createEvolutionStore(
  options: { rootDir?: string; homeDir?: string } = {},
): EvolutionStore {
  return {
    root_dir:
      options.rootDir ??
      process.env.UNICLI_EVOLUTION_ROOT ??
      (options.homeDir
        ? join(options.homeDir, ".unicli", "evolution")
        : join(userDataRoot(), "evolution")),
  };
}

export function createEvolutionSessionId(): string {
  return `evo-${new Date()
    .toISOString()
    .replaceAll(/[-:.TZ]/g, "")
    .slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

export function assertEvolutionSessionId(sessionId: string): void {
  if (!/^evo-[A-Za-z0-9._-]+$/.test(sessionId)) {
    throw new EvolutionError(
      "invalid_session_id",
      `invalid evolution session id: ${sessionId}`,
    );
  }
}

export function evolutionSessionPaths(
  store: EvolutionStore,
  sessionId: string,
  site: string,
  command: string,
): EvolutionSessionPaths {
  assertEvolutionSessionId(sessionId);
  assertAdapterSegment(site, "site");
  assertAdapterSegment(command, "command");
  const root = join(store.root_dir, sessionId);
  const baselineOverlay = join(root, "overlays", "baseline");
  const candidateOverlay = join(root, "overlays", "candidate");
  return {
    root,
    manifest: join(root, "session.json"),
    evidence: join(root, "evidence.json"),
    baseline_overlay: baselineOverlay,
    baseline_file: join(baselineOverlay, site, `${command}.yaml`),
    candidate_overlay: candidateOverlay,
    candidate_file: join(candidateOverlay, site, `${command}.yaml`),
    patch: join(root, "candidate.patch"),
    verification: join(root, "verification.json"),
    promotion: join(root, "promotion.json"),
    rollback: join(root, "rollback.yaml"),
    baseline_runs: join(root, "runs", "baseline"),
    candidate_runs: join(root, "runs", "candidate"),
  };
}

export async function initializeEvolutionSession(
  paths: EvolutionSessionPaths,
): Promise<void> {
  if (existsSync(paths.root)) {
    throw new EvolutionError(
      "invalid_session",
      `evolution session already exists: ${paths.root}`,
      paths.root,
    );
  }
  for (const dir of [
    paths.root,
    dirname(paths.baseline_file),
    dirname(paths.candidate_file),
    paths.baseline_runs,
    paths.candidate_runs,
  ]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await ownerOnly(dir, 0o700);
  }
}

export async function writePrivateJson(
  path: string,
  value: unknown,
): Promise<void> {
  await writePrivateText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writePrivateText(
  path: string,
  value: string,
): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFileTransactionally(path, Buffer.from(value), { mode: 0o600 });
    await ownerOnly(path, 0o600);
  } catch (error) {
    throw asStoreIoError(error, path, "write");
  }
}

export async function readPrivateJson<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch (error) {
    throw asStoreIoError(error, path, "read");
  }
}

export async function readEvolutionSession(
  store: EvolutionStore,
  sessionId: string,
): Promise<EvolutionSession> {
  assertEvolutionSessionId(sessionId);
  const path = join(store.root_dir, sessionId, "session.json");
  if (!existsSync(path)) {
    throw new EvolutionError(
      "session_not_found",
      `evolution session not found: ${sessionId}`,
      path,
    );
  }
  const value = await readPrivateJson<unknown>(path);
  if (!isEvolutionSession(value) || value.session_id !== sessionId) {
    throw new EvolutionError(
      "invalid_session",
      `invalid evolution session manifest: ${path}`,
      path,
    );
  }
  assertSessionArtifactPaths(store, value);
  return value;
}

export async function writeEvolutionSession(
  store: EvolutionStore,
  session: EvolutionSession,
): Promise<void> {
  const path = join(store.root_dir, session.session_id, "session.json");
  await writePrivateJson(path, session);
}

export async function listEvolutionSessions(
  store: EvolutionStore,
): Promise<EvolutionSession[]> {
  const entries = await readdir(store.root_dir, { withFileTypes: true }).catch(
    () => [],
  );
  const sessions: EvolutionSession[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("evo-")) continue;
    try {
      sessions.push(await readEvolutionSession(store, entry.name));
    } catch {
      continue;
    }
  }
  return sessions.sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at),
  );
}

export function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertAdapterSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new EvolutionError(
      "invalid_session",
      `invalid adapter ${label}: ${value}`,
    );
  }
}

function isEvolutionSession(value: unknown): value is EvolutionSession {
  if (!isRecord(value)) return false;
  const record = value as Partial<EvolutionSession>;
  const component = record.component;
  const scope = component?.scope;
  const datasets = record.datasets;
  const runtime = record.runtime;
  return (
    record.schema_version === "unicli.evolution-session.v1" &&
    typeof record.session_id === "string" &&
    ["draft", "verified", "rejected", "promoted", "rolled_back"].includes(
      String(record.state),
    ) &&
    typeof record.created_at === "string" &&
    typeof record.updated_at === "string" &&
    component?.kind === "adapter" &&
    typeof component.id === "string" &&
    typeof component.site === "string" &&
    typeof component.command === "string" &&
    typeof component.source_path === "string" &&
    ["packaged", "user", "runtime"].includes(component.source_tier) &&
    typeof component.editable_path === "string" &&
    Boolean(scope) &&
    Array.isArray(scope?.model_affinity) &&
    scope.model_affinity.every((entry) => typeof entry === "string") &&
    typeof scope.permission_profile === "string" &&
    isArtifactRef(record.evidence) &&
    typeof record.evidence.packet_id === "string" &&
    isArtifactRef(record.baseline) &&
    isArtifactRef(record.candidate) &&
    Boolean(datasets) &&
    isStringArray(datasets?.proposal_run_ids) &&
    isStringArray(datasets?.validation_run_ids) &&
    isStringArray(datasets?.held_out_run_ids) &&
    isStringArray(datasets?.validation_eval_targets) &&
    isStringArray(datasets?.held_out_eval_targets) &&
    Boolean(runtime) &&
    typeof runtime?.run_root === "string" &&
    typeof runtime.cli_command === "string" &&
    Number.isInteger(runtime.timeout_ms) &&
    runtime.timeout_ms > 0 &&
    typeof runtime.allow_mutation_eval === "boolean" &&
    (record.prediction === undefined || isPrediction(record.prediction))
  );
}

function isPrediction(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.hypothesis === "string" &&
    isStringArray(value.expected_fixes) &&
    value.expected_fixes.length > 0 &&
    isStringArray(value.at_risk)
  );
}

function assertSessionArtifactPaths(
  store: EvolutionStore,
  session: EvolutionSession,
): void {
  const expected = evolutionSessionPaths(
    store,
    session.session_id,
    session.component.site,
    session.component.command,
  );
  const actual = [
    [
      "component.editable_path",
      session.component.editable_path,
      expected.candidate_file,
    ],
    ["evidence.path", session.evidence.path, expected.evidence],
    ["baseline.path", session.baseline.path, expected.baseline_file],
    ["candidate.path", session.candidate.path, expected.candidate_file],
    ...(session.verification
      ? [
          [
            "verification.path",
            session.verification.path,
            expected.verification,
          ],
        ]
      : []),
    ...(session.promotion
      ? [["promotion.path", session.promotion.path, expected.promotion]]
      : []),
  ];
  const mismatch = actual.find(
    ([, path, expectedPath]) => path !== expectedPath,
  );
  if (mismatch) {
    throw new EvolutionError(
      "invalid_session",
      `invalid evolution session artifact path ${mismatch[0]}: ${mismatch[1]}`,
      mismatch[1],
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArtifactRef(
  value: unknown,
): value is { path: string; sha256: string } {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.sha256 === "string"
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

async function ownerOnly(path: string, mode: number): Promise<void> {
  if (process.platform !== "win32") await chmod(path, mode);
}

function asStoreIoError(
  error: unknown,
  path: string,
  operation: string,
): EvolutionError {
  if (error instanceof EvolutionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new EvolutionError(
    "io_error",
    `failed to ${operation} evolution artifact: ${message}`,
    path,
  );
}
