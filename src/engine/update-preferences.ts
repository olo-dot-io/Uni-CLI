/**
 * @owner   src::engine::update-preferences
 * @does    Persist remind-later and skip-this-version choices for update prompts.
 * @needs   Owner-only local state under ~/.unicli or an explicit test path.
 * @feeds   update check suppression and the interactive upgrade command.
 * @breaks  Lost choices make every CLI invocation repeat the same update prompt.
 * @invariants A dismissal applies only to one exact release; a deferral expires after a bounded interval.
 * @side-effects Reads and atomically replaces one owner-only JSON file.
 * @perf    O(1) over a three-field document.
 * @concurrency Random temporary files make concurrent writers safe; last completed choice wins.
 * @test    tests/unit/update-preferences.test.ts
 * @stability stable.
 * @since   2026-08-10
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const UPDATE_REMIND_LATER_MS = 24 * 60 * 60 * 1000;

export interface UpdatePreferences {
  dismissedVersion?: string;
  deferredVersion?: string;
  deferredUntil?: number;
  automaticUpdates?: boolean;
}

export type UpdateSuppression = "dismissed" | "deferred" | undefined;

export function updatePreferencesPath(env: NodeJS.ProcessEnv): string {
  return (
    env.UNICLI_UPDATE_PREFERENCES_PATH ??
    join(env.HOME || homedir(), ".unicli", "update-preferences.json")
  );
}

export function readUpdatePreferences(
  env: NodeJS.ProcessEnv = process.env,
): UpdatePreferences {
  try {
    const parsed = JSON.parse(
      readFileSync(updatePreferencesPath(env), "utf-8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const value = parsed as Record<string, unknown>;
    return {
      ...(typeof value.dismissedVersion === "string"
        ? { dismissedVersion: value.dismissedVersion }
        : {}),
      ...(typeof value.deferredVersion === "string"
        ? { deferredVersion: value.deferredVersion }
        : {}),
      ...(typeof value.deferredUntil === "number" &&
      Number.isFinite(value.deferredUntil)
        ? { deferredUntil: value.deferredUntil }
        : {}),
      ...(typeof value.automaticUpdates === "boolean"
        ? { automaticUpdates: value.automaticUpdates }
        : {}),
    };
  } catch {
    return {};
  }
}

export function updateSuppression(
  latest: string,
  preferences: UpdatePreferences,
  now = Date.now(),
): UpdateSuppression {
  if (preferences.dismissedVersion === latest) return "dismissed";
  if (
    preferences.deferredVersion === latest &&
    preferences.deferredUntil !== undefined &&
    preferences.deferredUntil > now
  ) {
    return "deferred";
  }
  return undefined;
}

export function deferUpdate(
  latest: string,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): UpdatePreferences {
  const preferences: UpdatePreferences = {
    ...readUpdatePreferences(env),
    deferredVersion: latest,
    deferredUntil: now + UPDATE_REMIND_LATER_MS,
  };
  writeUpdatePreferences(preferences, env);
  return preferences;
}

export function dismissUpdate(
  latest: string,
  env: NodeJS.ProcessEnv = process.env,
): UpdatePreferences {
  const { automaticUpdates } = readUpdatePreferences(env);
  const preferences: UpdatePreferences = {
    dismissedVersion: latest,
    ...(automaticUpdates === undefined ? {} : { automaticUpdates }),
  };
  writeUpdatePreferences(preferences, env);
  return preferences;
}

export function clearUpdatePreferences(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const { automaticUpdates } = readUpdatePreferences(env);
  writeUpdatePreferences(
    automaticUpdates === undefined ? {} : { automaticUpdates },
    env,
  );
}

export function setAutomaticUpdates(
  enabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): UpdatePreferences {
  const preferences: UpdatePreferences = {
    ...readUpdatePreferences(env),
    automaticUpdates: enabled,
  };
  writeUpdatePreferences(preferences, env);
  return preferences;
}

function writeUpdatePreferences(
  preferences: UpdatePreferences,
  env: NodeJS.ProcessEnv,
): void {
  const path = updatePreferencesPath(env);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  const temporary = join(
    directory,
    `.update-preferences.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(preferences)}\n`, {
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
          "Update preference write and cleanup both failed",
        );
      }
    }
    throw error;
  }
}
