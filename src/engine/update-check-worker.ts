/**
 * @owner       src::engine::update-check-worker
 * @does        Refreshes scoped npm release metadata in a detached process and atomically replaces the local cache.
 * @needs       same-package proxy-aware fetch, node fs/path/os/crypto/url
 * @feeds       src::engine::update-check cache reader
 * @breaks      HTTP, JSON, version-validation, write, and cleanup failures terminate the worker non-zero.
 * @invariants  Only a valid semantic version from the scoped package endpoint reaches the cache.
 * @side-effects Performs one bounded HTTP request and one same-directory atomic cache replacement.
 * @perf        Three-second default network deadline; the foreground CLI never awaits this process.
 * @concurrency Random owner-only temporary files make concurrent workers safe; last completed rename wins.
 * @test        tests/unit/update-check.test.ts
 * @stability   stable
 * @since       2026-07-12
 */

import {
  chmodSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchWithProxy } from "./proxy.js";
import {
  UPDATE_REGISTRY_URL,
  isValidVersion,
  type UpdateCache,
} from "./update-check.js";

export interface UpdateRefreshOptions {
  registryUrl?: string;
  cachePath?: string;
  timeoutMs?: number;
  now?: () => number;
}

function defaultCachePath(): string {
  return join(homedir(), ".unicli", "update-check.json");
}

function removeTempFile(path: string, original: unknown): never {
  try {
    unlinkSync(path);
  } catch (cleanupError) {
    const missing = (cleanupError as NodeJS.ErrnoException).code === "ENOENT";
    if (!missing) {
      throw new AggregateError(
        [original, cleanupError],
        "Update cache write and cleanup both failed",
      );
    }
  }
  throw original;
}

function writeCache(path: string, cache: UpdateCache): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  const tempPath = join(
    directory,
    `.update-check.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(tempPath, `${JSON.stringify(cache)}\n`, {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    if (process.platform !== "win32") chmodSync(tempPath, 0o600);
    renameSync(tempPath, path);
  } catch (error) {
    removeTempFile(tempPath, error);
  }
}

export async function refreshUpdateCache(
  options: UpdateRefreshOptions = {},
): Promise<UpdateCache> {
  const response = await fetchWithProxy(
    options.registryUrl ?? UPDATE_REGISTRY_URL,
    { signal: AbortSignal.timeout(options.timeoutMs ?? 3000) },
  );
  if (!response.ok) {
    throw new Error(`npm registry returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as unknown;
  const latest =
    typeof body === "object" && body !== null
      ? (body as { version?: unknown }).version
      : undefined;
  if (typeof latest !== "string" || !isValidVersion(latest)) {
    throw new Error("npm registry response has no valid semantic version");
  }
  const cache = { latest, checkedAt: (options.now ?? Date.now)() };
  writeCache(options.cachePath ?? defaultCachePath(), cache);
  return cache;
}

function isDirectExecution(): boolean {
  return Boolean(
    process.argv[1] &&
    resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)),
  );
}

if (isDirectExecution()) {
  refreshUpdateCache({
    registryUrl: process.env.UNICLI_UPDATE_CHECK_URL,
    cachePath: process.env.UNICLI_UPDATE_CHECK_CACHE_PATH,
  }).then(
    () => process.exit(0),
    () => process.exit(1),
  );
}
