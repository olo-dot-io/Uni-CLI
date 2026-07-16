/**
 * @owner       src/browser/kernel-file-lock.ts
 * @does        Acquire a non-blocking kernel advisory lock whose lifetime is owned directly by the calling Node process.
 * @needs       node:child_process, node:fs
 * @feeds       src/browser/profile-seed.ts, src/browser/runtime-transport.ts
 * @breaks      KernelFileLockError on contention, unsupported operating systems, lock-file failures, or lock-provider failures.
 * @invariants  The persistent lock inode is never unlinked; lockf or flock locks an inherited open file description; the caller retains that description after the helper exits; release is idempotent; process exit releases ownership atomically.
 * @side-effects Creates or opens one mode-0600 lock file, briefly executes the platform lock provider, and retains one file descriptor until release.
 * @perf        One synchronous local process invocation per acquisition; no resident guardian process.
 * @concurrency A paused caller keeps the lock because it owns the open file description; a terminated caller releases it without stale-owner arbitration.
 * @test        tests/unit/kernel-file-lock.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  openSync,
} from "node:fs";

export type KernelFileLockErrorCode =
  | "contended"
  | "unsupported"
  | "unavailable";

export class KernelFileLockError extends Error {
  constructor(
    readonly code: KernelFileLockErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "KernelFileLockError";
  }
}

export interface KernelFileLock {
  readonly path: string;
  release(): void;
}

interface KernelLockProvider {
  executable: string;
  args: string[];
  contentionExitCode: number;
}

export function acquireKernelFileLock(path: string): KernelFileLock {
  const provider = kernelLockProvider();
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_CREAT | constants.O_RDWR, 0o600);
    if (!fstatSync(descriptor).isFile()) {
      throw new KernelFileLockError(
        "unavailable",
        `Kernel lock path is not a regular file: ${path}`,
      );
    }
    fchmodSync(descriptor, 0o600);
  } catch (error) {
    const wrapped =
      error instanceof KernelFileLockError
        ? error
        : new KernelFileLockError(
            "unavailable",
            `Kernel lock file could not be opened at ${path}: ${errorMessage(error)}`,
            { cause: error },
          );
    if (descriptor !== undefined) {
      closeAfterFailedAcquire(descriptor, path, wrapped);
    }
    throw wrapped;
  }

  try {
    const result = spawnSync(provider.executable, provider.args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "ignore", "pipe", descriptor],
      timeout: 5_000,
    });
    if (result.error) {
      throw new KernelFileLockError(
        "unavailable",
        `Kernel lock provider failed for ${path}: ${result.error.message}`,
        { cause: result.error },
      );
    }
    if (result.status === provider.contentionExitCode) {
      throw new KernelFileLockError(
        "contended",
        `Kernel lock is already held: ${path}`,
      );
    }
    if (result.status !== 0) {
      throw new KernelFileLockError(
        "unavailable",
        `Kernel lock provider exited ${String(result.status)} for ${path}: ${result.stderr.trim() || result.signal || "no diagnostic"}`,
      );
    }
  } catch (error) {
    closeAfterFailedAcquire(descriptor, path, error);
  }

  let ownedDescriptor: number | null = descriptor;
  return {
    path,
    release(): void {
      if (ownedDescriptor === null) return;
      const descriptorToClose = ownedDescriptor;
      ownedDescriptor = null;
      closeSync(descriptorToClose);
    },
  };
}

function kernelLockProvider(): KernelLockProvider {
  if (process.platform === "darwin" || process.platform.endsWith("bsd")) {
    return {
      executable: "/usr/bin/lockf",
      args: ["-s", "-t", "0", "3"],
      contentionExitCode: 75,
    };
  }
  if (process.platform === "linux") {
    const executable = existsSync("/usr/bin/flock")
      ? "/usr/bin/flock"
      : "/bin/flock";
    return {
      executable,
      args: ["-n", "3"],
      contentionExitCode: 1,
    };
  }
  throw new KernelFileLockError(
    "unsupported",
    `No verified process-owned kernel file lock provider exists for ${process.platform}`,
  );
}

function closeAfterFailedAcquire(
  descriptor: number,
  path: string,
  acquisitionError: unknown,
): never {
  try {
    closeSync(descriptor);
  } catch (closeError) {
    throw new KernelFileLockError(
      "unavailable",
      `Kernel lock acquisition and descriptor cleanup both failed for ${path}: ${errorMessage(acquisitionError)}; ${errorMessage(closeError)}`,
      { cause: new AggregateError([acquisitionError, closeError]) },
    );
  }
  throw acquisitionError;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
