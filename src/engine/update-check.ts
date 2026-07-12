/**
 * @owner       src::engine::update-check
 * @does        Reads cached npm release metadata and launches a detached refresh worker without retaining the CLI process.
 * @needs       node fs/path/os/url/child_process, package VERSION, compiled update-check-worker
 * @feeds       src::cli interactive update notice
 * @breaks      Invalid or stale cache data triggers a background refresh; worker launch errors are explicit in debug mode.
 * @invariants  The scoped package URL matches package.json; network I/O never runs in the foreground CLI process.
 * @side-effects Reads one cache file, may register an exit notice, and may spawn one detached background worker.
 * @perf        Fresh-cache reads are synchronous and bounded; refresh launch returns without awaiting network I/O.
 * @concurrency The cache worker owns atomic replacement; duplicate CLI launches may race safely with last-completed write winning.
 * @test        tests/unit/update-check.test.ts and startup acceptance benchmark
 * @stability   stable
 * @since       2026-04-01
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { VERSION } from "../constants.js";

export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_REGISTRY_URL =
  "https://registry.npmjs.org/%40zenalexa%2Funicli/latest";

export interface UpdateCache {
  latest: string;
  checkedAt: number;
}

export type UpdateCheckStatus =
  | "disabled"
  | "fresh"
  | "refresh-started"
  | "worker-missing"
  | "spawn-failed";

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

function parseVersion(value: string): ParsedVersion | undefined {
  const numeric = "(?:0|[1-9]\\d*)";
  const match = new RegExp(
    `^v?(${numeric})\\.(${numeric})\\.(${numeric})(?:-([0-9A-Za-z.-]+))?(?:\\+[0-9A-Za-z.-]+)?$`,
  ).exec(value);
  if (!match) return undefined;
  const prerelease = match[4]?.split(".") ?? [];
  if (
    prerelease.some(
      (identifier) =>
        identifier.length === 0 ||
        (/^\d+$/.test(identifier) &&
          identifier.length > 1 &&
          identifier.startsWith("0")),
    )
  ) {
    return undefined;
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease,
  };
}

export function isValidVersion(value: string): boolean {
  return parseVersion(value) !== undefined;
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    if (left.length === right.length) return 0;
    return left.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const l = left[index];
    const r = right[index];
    if (l === undefined || r === undefined) {
      if (l === r) return 0;
      return l === undefined ? -1 : 1;
    }
    if (l === r) continue;
    const lNumber = /^\d+$/.test(l) ? Number(l) : undefined;
    const rNumber = /^\d+$/.test(r) ? Number(r) : undefined;
    if (lNumber !== undefined && rNumber !== undefined) {
      return lNumber > rNumber ? 1 : -1;
    }
    if (lNumber !== undefined || rNumber !== undefined) {
      return lNumber !== undefined ? -1 : 1;
    }
    return l > r ? 1 : -1;
  }
  return 0;
}

export function isNewer(latest: string, current: string): boolean {
  const left = parseVersion(latest);
  const right = parseVersion(current);
  if (!left || !right) return false;
  for (let index = 0; index < left.core.length; index += 1) {
    const l = left.core[index] ?? 0;
    const r = right.core[index] ?? 0;
    if (l !== r) return l > r;
  }
  return comparePrerelease(left.prerelease, right.prerelease) > 0;
}

function cachePath(env: NodeJS.ProcessEnv): string {
  return (
    env.UNICLI_UPDATE_CHECK_CACHE_PATH ??
    join(homedir(), ".unicli", "update-check.json")
  );
}

function readCache(path: string): UpdateCache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { latest?: unknown }).latest !== "string" ||
      !parseVersion((parsed as { latest: string }).latest) ||
      typeof (parsed as { checkedAt?: unknown }).checkedAt !== "number" ||
      !Number.isFinite((parsed as { checkedAt: number }).checkedAt)
    ) {
      return undefined;
    }
    return parsed as UpdateCache;
  } catch {
    return undefined;
  }
}

function compiledWorkerPath(env: NodeJS.ProcessEnv): string {
  if (env.UNICLI_UPDATE_CHECK_WORKER_PATH) {
    return resolve(env.UNICLI_UPDATE_CHECK_WORKER_PATH);
  }
  const current = fileURLToPath(import.meta.url);
  if (current.endsWith(".ts")) {
    return resolve(
      dirname(current),
      "../../dist/engine/update-check-worker.js",
    );
  }
  return resolve(dirname(current), "update-check-worker.js");
}

function reportDebug(message: string, env: NodeJS.ProcessEnv): void {
  if (env.UNICLI_UPDATE_CHECK_DEBUG === "1") {
    process.stderr.write(`[update-check] ${message}\n`);
  }
}

function startRefreshWorker(env: NodeJS.ProcessEnv): UpdateCheckStatus {
  const workerPath = compiledWorkerPath(env);
  if (!existsSync(workerPath)) {
    reportDebug(`compiled worker missing at ${workerPath}`, env);
    return "worker-missing";
  }
  try {
    const child = spawn(process.execPath, [workerPath], {
      detached: true,
      env,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", (error) => {
      reportDebug(`worker launch failed: ${error.message}`, env);
    });
    child.unref();
    return "refresh-started";
  } catch (error) {
    reportDebug(
      `worker launch failed: ${error instanceof Error ? error.message : String(error)}`,
      env,
    );
    return "spawn-failed";
  }
}

let registeredNotice = false;
function registerExitMessage(latest: string): void {
  if (registeredNotice) return;
  registeredNotice = true;
  process.on("exit", (code) => {
    if (code === 0) {
      process.stderr.write(
        `\n${chalk.yellow(`Update available: ${VERSION} → ${latest}`)} — run ${chalk.cyan("npm i -g @zenalexa/unicli")} to upgrade\n`,
      );
    }
  });
}

export function checkForUpdates(
  env: NodeJS.ProcessEnv = process.env,
): UpdateCheckStatus {
  if (
    env.CI ||
    env.NO_UPDATE_NOTIFIER === "1" ||
    env.UNICLI_DISABLE_UPDATE_CHECK === "1" ||
    (!process.stderr.isTTY && env.UNICLI_UPDATE_CHECK_FORCE !== "1")
  ) {
    return "disabled";
  }

  const now = Date.now();
  const cached = readCache(cachePath(env));
  if (cached && isNewer(cached.latest, VERSION)) {
    registerExitMessage(cached.latest);
  }
  if (cached) {
    const age = now - cached.checkedAt;
    if (age >= 0 && age < UPDATE_CHECK_TTL_MS) return "fresh";
  }
  return startRefreshWorker(env);
}
