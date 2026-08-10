/**
 * @owner       src::engine::update-auto-worker
 * @does        Installs one scheduled exact Uni-CLI release and records its durable result.
 * @needs       automatic-update lease/state, exact validated version, shared package-manager installer
 * @feeds       the next old-version Agent invocation and release recovery diagnostics
 * @breaks      A lost completion record can trigger redundant retries; a leaked lease can delay recovery.
 * @invariants  Only a valid semantic version and declared npm, pnpm, or Bun manager reach the installer.
 * @side-effects Spawns one global package-manager install, updates owner-only state, and releases one lease.
 * @perf        Runs outside the foreground CLI; output capture stays bounded to 4,000 characters.
 * @concurrency The parent scheduler creates the exact lease token consumed here.
 * @test        tests/unit/update-auto.test.ts
 * @stability   stable detached worker
 * @since       2026-08-10
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  releaseAutomaticUpdateLease,
  writeAutomaticUpdateState,
  type AutomaticUpdateState,
} from "./update-auto.js";
import {
  runPackageManagerInstall,
  type InstallResult,
  type UpdatePackageManager,
} from "./update-install.js";
import { clearUpdatePreferences } from "./update-preferences.js";
import { isValidVersion } from "./update-check.js";

export interface AutomaticUpdateWorkerRuntime {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  install?: (
    manager: UpdatePackageManager,
    latest: string,
  ) => Promise<InstallResult>;
}

export async function runAutomaticUpdateWorker(
  runtime: AutomaticUpdateWorkerRuntime = {},
): Promise<number> {
  const env = runtime.env ?? process.env;
  const latest = env.UNICLI_AUTO_UPDATE_LATEST;
  const manager = parsePackageManager(env.UNICLI_AUTO_UPDATE_MANAGER);
  const token = env.UNICLI_AUTO_UPDATE_LEASE_TOKEN;
  if (!latest || !isValidVersion(latest) || !manager || !token) return 64;

  const now = runtime.now ?? Date.now;
  const running: AutomaticUpdateState = {
    version: latest,
    packageManager: manager,
    status: "running",
    startedAt: now(),
  };

  try {
    writeAutomaticUpdateState(running, env);
    const install =
      runtime.install ??
      ((selectedManager, selectedVersion) =>
        runPackageManagerInstall(selectedManager, selectedVersion, env));
    const result = await install(manager, latest);
    const completedAt = now();
    if (result.exitCode !== 0) {
      writeAutomaticUpdateState(
        {
          ...running,
          status: "failed",
          completedAt,
          error: boundedError(
            result.output || `package manager exited ${result.exitCode}`,
          ),
        },
        env,
      );
      return result.exitCode || 1;
    }
    clearUpdatePreferences(env);
    writeAutomaticUpdateState(
      { ...running, status: "succeeded", completedAt },
      env,
    );
    return 0;
  } catch (error) {
    writeAutomaticUpdateState(
      {
        ...running,
        status: "failed",
        completedAt: now(),
        error: boundedError(error),
      },
      env,
    );
    return 1;
  } finally {
    releaseAutomaticUpdateLease(env, token);
  }
}

function parsePackageManager(
  value: string | undefined,
): UpdatePackageManager | undefined {
  if (value === "npm" || value === "pnpm" || value === "bun") return value;
  return undefined;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    1000,
  );
}

function isDirectExecution(): boolean {
  return Boolean(
    process.argv[1] &&
    resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)),
  );
}

if (isDirectExecution()) {
  runAutomaticUpdateWorker().then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
