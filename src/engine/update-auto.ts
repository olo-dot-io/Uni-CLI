/**
 * @owner       src::engine::update-auto
 * @does        Schedules one detached exact-version update for non-interactive Agents while preserving an interactive Y/N path.
 * @needs       cached release version, persistent package-manager detection, owner-only local state, compiled worker
 * @feeds       update notices and the detached automatic-update worker
 * @breaks      Duplicate schedules can race global installers; a stale lease can suppress recovery.
 * @invariants  CI, source checkouts, ephemeral runners, explicit opt-out, and interactive terminals never auto-install by default.
 * @side-effects Reads and atomically writes owner-only state, claims one lease, and may spawn one detached worker.
 * @perf        O(1) local file work on a cached update path; no foreground network or package-manager wait.
 * @concurrency An exact-version lease allows one worker; stale leases expire after a bounded interval.
 * @test        tests/unit/update-auto.test.ts
 * @stability   stable Agent update policy
 * @since       2026-08-10
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  detectUpdatePackageManager,
  type UpdatePackageManager,
} from "./update-install.js";
import { readUpdatePreferences } from "./update-preferences.js";

export const AUTO_UPDATE_LEASE_TTL_MS = 15 * 60 * 1000;
export const AUTO_UPDATE_RETRY_MS = 60 * 60 * 1000;

export type AutomaticUpdateStatus =
  | "scheduled"
  | "running"
  | "succeeded"
  | "retry_later"
  | "interactive_choice"
  | "disabled"
  | "unsupported"
  | "unavailable";

export interface AutomaticUpdateDecision {
  enabled: boolean;
  status: AutomaticUpdateStatus;
  package_manager?: UpdatePackageManager;
  opt_out: "UNICLI_AUTO_UPDATE=0";
}

export interface AutomaticUpdateState {
  version: string;
  packageManager: UpdatePackageManager;
  status: "scheduled" | "running" | "succeeded" | "failed";
  startedAt: number;
  completedAt?: number;
  error?: string;
}

export interface AutomaticUpdateOptions {
  interactive?: boolean;
  scriptPath?: string;
  workerPath?: string;
  now?: () => number;
  launch?: (workerPath: string, env: NodeJS.ProcessEnv) => void;
}

export function automaticUpdateStatePath(env: NodeJS.ProcessEnv): string {
  return (
    env.UNICLI_AUTO_UPDATE_STATE_PATH ??
    join(env.HOME || homedir(), ".unicli", "automatic-update.json")
  );
}

export function automaticUpdateLeasePath(env: NodeJS.ProcessEnv): string {
  return (
    env.UNICLI_AUTO_UPDATE_LEASE_PATH ??
    join(env.HOME || homedir(), ".unicli", "automatic-update.lock")
  );
}

export function readAutomaticUpdateState(
  env: NodeJS.ProcessEnv = process.env,
): AutomaticUpdateState | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(automaticUpdateStatePath(env), "utf-8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const value = parsed as Record<string, unknown>;
    if (
      typeof value.version !== "string" ||
      !isUpdatePackageManager(value.packageManager) ||
      !isAutomaticUpdateStateStatus(value.status) ||
      typeof value.startedAt !== "number" ||
      !Number.isFinite(value.startedAt)
    ) {
      return undefined;
    }
    return {
      version: value.version,
      packageManager: value.packageManager,
      status: value.status,
      startedAt: value.startedAt,
      ...(typeof value.completedAt === "number" &&
      Number.isFinite(value.completedAt)
        ? { completedAt: value.completedAt }
        : {}),
      ...(typeof value.error === "string" ? { error: value.error } : {}),
    };
  } catch {
    return undefined;
  }
}

export function writeAutomaticUpdateState(
  state: AutomaticUpdateState,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const path = automaticUpdateStatePath(env);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  const temporary = join(
    directory,
    `.automatic-update.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    if (process.platform !== "win32") chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AggregateError(
          [error, cleanupError],
          "Automatic update state write and cleanup both failed",
        );
      }
    }
    throw error;
  }
}

export function scheduleAutomaticUpdate(
  latest: string,
  env: NodeJS.ProcessEnv = process.env,
  options: AutomaticUpdateOptions = {},
): AutomaticUpdateDecision {
  const optOut = "UNICLI_AUTO_UPDATE=0" as const;
  const automaticSetting = env.UNICLI_AUTO_UPDATE?.trim().toLowerCase();
  const explicitlyEnabled =
    automaticSetting === "1" ||
    automaticSetting === "true" ||
    automaticSetting === "on";
  const explicitlyDisabled =
    automaticSetting === "0" ||
    automaticSetting === "false" ||
    automaticSetting === "off" ||
    env.UNICLI_DISABLE_AUTO_UPDATE === "1";
  const storedSetting = readUpdatePreferences(env).automaticUpdates;
  if (
    explicitlyDisabled ||
    (automaticSetting === undefined && storedSetting === false) ||
    Boolean(env.CI) ||
    env.NODE_ENV === "test"
  ) {
    return { enabled: false, status: "disabled", opt_out: optOut };
  }

  const interactive =
    options.interactive ??
    Boolean(
      process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY,
    );
  if (interactive && !explicitlyEnabled && storedSetting !== true) {
    return {
      enabled: false,
      status: "interactive_choice",
      opt_out: optOut,
    };
  }

  const scriptPath = options.scriptPath ?? fileURLToPath(import.meta.url);
  const manager = detectUpdatePackageManager(scriptPath);
  if (!manager) {
    return { enabled: false, status: "unsupported", opt_out: optOut };
  }

  const now = (options.now ?? Date.now)();
  const state = readAutomaticUpdateState(env);
  if (state?.version === latest) {
    if (state.status === "succeeded") {
      return {
        enabled: true,
        status: "succeeded",
        package_manager: manager,
        opt_out: optOut,
      };
    }
    if (
      (state.status === "scheduled" || state.status === "running") &&
      now - state.startedAt < AUTO_UPDATE_LEASE_TTL_MS
    ) {
      return {
        enabled: true,
        status: "running",
        package_manager: manager,
        opt_out: optOut,
      };
    }
    if (
      state.status === "failed" &&
      state.completedAt !== undefined &&
      now - state.completedAt < AUTO_UPDATE_RETRY_MS
    ) {
      return {
        enabled: true,
        status: "retry_later",
        package_manager: manager,
        opt_out: optOut,
      };
    }
  }

  const workerPath =
    options.workerPath ?? compiledAutomaticUpdateWorkerPath(env);
  if (!existsSync(workerPath)) {
    return {
      enabled: true,
      status: "unavailable",
      package_manager: manager,
      opt_out: optOut,
    };
  }

  const token = randomUUID();
  const leasePath = automaticUpdateLeasePath(env);
  if (!claimAutomaticUpdateLease(leasePath, token, now)) {
    return {
      enabled: true,
      status: "running",
      package_manager: manager,
      opt_out: optOut,
    };
  }

  const scheduled: AutomaticUpdateState = {
    version: latest,
    packageManager: manager,
    status: "scheduled",
    startedAt: now,
  };
  try {
    writeAutomaticUpdateState(scheduled, env);
    const workerEnv = {
      ...env,
      UNICLI_AUTO_UPDATE_LATEST: latest,
      UNICLI_AUTO_UPDATE_MANAGER: manager,
      UNICLI_AUTO_UPDATE_STATE_PATH: automaticUpdateStatePath(env),
      UNICLI_AUTO_UPDATE_LEASE_PATH: leasePath,
      UNICLI_AUTO_UPDATE_LEASE_TOKEN: token,
    };
    if (options.launch) {
      options.launch(workerPath, workerEnv);
    } else {
      launchAutomaticUpdateWorker(workerPath, workerEnv, scheduled, env, token);
    }
  } catch (error) {
    writeAutomaticUpdateState(
      {
        ...scheduled,
        status: "failed",
        completedAt: now,
        error: boundedError(error),
      },
      env,
    );
    releaseAutomaticUpdateLease(env, token);
    return {
      enabled: true,
      status: "unavailable",
      package_manager: manager,
      opt_out: optOut,
    };
  }

  return {
    enabled: true,
    status: "scheduled",
    package_manager: manager,
    opt_out: optOut,
  };
}

export function releaseAutomaticUpdateLease(
  env: NodeJS.ProcessEnv,
  token: string,
): void {
  const path = automaticUpdateLeasePath(env);
  try {
    if (readFileSync(path, "utf-8").trim() !== token) return;
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function claimAutomaticUpdateLease(
  path: string,
  token: string,
  now: number,
): boolean {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, `${token}\n`, {
        encoding: "utf-8",
        flag: "wx",
        mode: 0o600,
      });
      if (process.platform !== "win32") chmodSync(path, 0o600);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt > 0) return false;
      try {
        if (now - statSync(path).mtimeMs < AUTO_UPDATE_LEASE_TTL_MS) {
          return false;
        }
        unlinkSync(path);
      } catch (leaseError) {
        if ((leaseError as NodeJS.ErrnoException).code !== "ENOENT") {
          return false;
        }
      }
    }
  }
  return false;
}

function compiledAutomaticUpdateWorkerPath(env: NodeJS.ProcessEnv): string {
  if (env.UNICLI_AUTO_UPDATE_WORKER_PATH) {
    return resolve(env.UNICLI_AUTO_UPDATE_WORKER_PATH);
  }
  const current = fileURLToPath(import.meta.url);
  if (current.endsWith(".ts")) {
    return resolve(dirname(current), "../../dist/engine/update-auto-worker.js");
  }
  return resolve(dirname(current), "update-auto-worker.js");
}

function launchAutomaticUpdateWorker(
  workerPath: string,
  workerEnv: NodeJS.ProcessEnv,
  scheduled: AutomaticUpdateState,
  stateEnv: NodeJS.ProcessEnv,
  token: string,
): void {
  const child = spawn(process.execPath, [workerPath], {
    detached: true,
    env: workerEnv,
    stdio: "ignore",
    windowsHide: true,
  });
  child.once("error", (error) => {
    writeAutomaticUpdateState(
      {
        ...scheduled,
        status: "failed",
        completedAt: Date.now(),
        error: boundedError(error),
      },
      stateEnv,
    );
    releaseAutomaticUpdateLease(stateEnv, token);
  });
  child.unref();
}

function isUpdatePackageManager(value: unknown): value is UpdatePackageManager {
  return value === "npm" || value === "pnpm" || value === "bun";
}

function isAutomaticUpdateStateStatus(
  value: unknown,
): value is AutomaticUpdateState["status"] {
  return (
    value === "scheduled" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed"
  );
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    1000,
  );
}
