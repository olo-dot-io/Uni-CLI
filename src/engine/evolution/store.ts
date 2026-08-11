import { chmod, mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";

import { userDataRoot } from "../user-home.js";
import { writeFileTransactionally } from "../transactional-file.js";
import {
  findRecoverableFileLockError,
  withRecoverableFileStoreLockAsync,
} from "../../runtime/recoverable-file-lock.js";
import type { EvolutionSession } from "./types.js";
import { EvolutionError } from "./error.js";

const artifactRefSchema = z.object({ path: z.string(), sha256: z.string() });
const attemptSchema = z.object({
  ordinal: z.number().int().positive(),
  verified_at: z.string(),
  eligible: z.boolean(),
  candidate_sha256: z.string(),
  candidate_path: z.string(),
  patch_path: z.string(),
  report_path: z.string(),
});
const sessionSchema = z
  .object({
    schema_version: z.literal("unicli.evolution-session.v1"),
    session_id: z.string(),
    state: z.enum(["draft", "verified", "rejected", "promoted", "rolled_back"]),
    created_at: z.string(),
    updated_at: z.string(),
    component: z.object({
      kind: z.literal("adapter"),
      id: z.string(),
      site: z.string(),
      command: z.string(),
      source_path: z.string(),
      source_tier: z.enum(["packaged", "user", "runtime"]),
      editable_path: z.string(),
      scope: z.object({
        domain: z.string().optional(),
        model_affinity: z.array(z.string()),
        permission_profile: z.string(),
        target_surface: z.string().optional(),
        operation_effect: z.string().optional(),
        execution_operator: z.string().optional(),
      }),
    }),
    evidence: artifactRefSchema.extend({ packet_id: z.string() }),
    baseline: artifactRefSchema,
    candidate: artifactRefSchema,
    datasets: z.object({
      proposal_run_ids: z.array(z.string()),
      validation_run_ids: z.array(z.string()),
      held_out_run_ids: z.array(z.string()),
      validation_eval_targets: z.array(z.string()),
      held_out_eval_targets: z.array(z.string()),
    }),
    runtime: z.object({
      run_root: z.string(),
      cli_command: z.string(),
      timeout_ms: z.number().int().positive(),
      allow_mutation_eval: z.boolean(),
    }),
    prediction: z
      .object({
        hypothesis: z.string(),
        expected_fixes: z.array(z.string()).min(1),
        at_risk: z.array(z.string()),
      })
      .optional(),
    attempts: z.array(attemptSchema),
    promotion: z
      .object({
        path: z.string(),
        promoted_at: z.string(),
        destination: z.string(),
      })
      .optional(),
  })
  .superRefine((session, context) => {
    if (
      session.attempts.some((attempt, index) => attempt.ordinal !== index + 1)
    ) {
      context.addIssue({ code: "custom", message: "non-contiguous attempts" });
    }
    const latest = session.attempts.at(-1);
    const validState =
      (session.state === "draft" &&
        session.attempts.length === 0 &&
        session.promotion === undefined) ||
      (session.state === "verified" &&
        latest?.eligible === true &&
        session.promotion === undefined) ||
      (session.state === "rejected" &&
        latest?.eligible === false &&
        session.promotion === undefined) ||
      ((session.state === "promoted" || session.state === "rolled_back") &&
        latest?.eligible === true &&
        session.promotion !== undefined);
    if (!validState) {
      context.addIssue({ code: "custom", message: "inconsistent state" });
    }
  });

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
  attempts: string;
  promotion: string;
  rollback: string;
  baseline_runs: string;
  candidate_runs: string;
}

export interface EvolutionAttemptPaths {
  root: string;
  candidate: string;
  patch: string;
  report: string;
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
    attempts: join(root, "attempts"),
    promotion: join(root, "promotion.json"),
    rollback: join(root, "rollback.yaml"),
    baseline_runs: join(root, "runs", "baseline"),
    candidate_runs: join(root, "runs", "candidate"),
  };
}

export function evolutionAttemptPaths(
  paths: EvolutionSessionPaths,
  ordinal: number,
): EvolutionAttemptPaths {
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new EvolutionError(
      "invalid_session",
      `invalid evolution attempt ordinal: ${ordinal}`,
    );
  }
  const root = join(paths.attempts, String(ordinal).padStart(4, "0"));
  return {
    root,
    candidate: join(root, "candidate.yaml"),
    patch: join(root, "candidate.patch"),
    report: join(root, "verification.json"),
  };
}

export async function initializeEvolutionSession(
  paths: EvolutionSessionPaths,
): Promise<void> {
  try {
    await mkdir(dirname(paths.root), { recursive: true, mode: 0o700 });
    await mkdir(paths.root, { mode: 0o700 });
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      throw new EvolutionError(
        "invalid_session",
        `evolution session already exists: ${paths.root}`,
        paths.root,
      );
    }
    throw asStoreIoError(error, paths.root, "create");
  }
  for (const dir of [
    dirname(paths.baseline_file),
    dirname(paths.candidate_file),
    paths.attempts,
    paths.baseline_runs,
    paths.candidate_runs,
  ]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await ownerOnly(dir, 0o700);
  }
}

export async function withEvolutionSessionLock<T>(
  store: EvolutionStore,
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  assertEvolutionSessionId(sessionId);
  const root = join(store.root_dir, sessionId);
  try {
    return await withRecoverableFileStoreLockAsync(root, operation);
  } catch (error) {
    const lockError = findRecoverableFileLockError(error);
    if (!lockError) throw error;
    throw new EvolutionError(
      "io_error",
      `failed to lock evolution session: ${lockError.message}`,
      lockError.path,
    );
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
  return sessionSchema.safeParse(value).success;
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
    ...session.attempts.flatMap((attempt) => {
      const expectedAttempt = evolutionAttemptPaths(expected, attempt.ordinal);
      return [
        [
          `attempts[${attempt.ordinal - 1}].candidate_path`,
          attempt.candidate_path,
          expectedAttempt.candidate,
        ],
        [
          `attempts[${attempt.ordinal - 1}].patch_path`,
          attempt.patch_path,
          expectedAttempt.patch,
        ],
        [
          `attempts[${attempt.ordinal - 1}].report_path`,
          attempt.report_path,
          expectedAttempt.report,
        ],
      ];
    }),
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

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
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
