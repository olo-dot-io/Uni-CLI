/**
 * @owner       src/browser/kernel-file-lock.ts
 * @does        Acquire a non-blocking kernel ownership lock keyed by a persistent regular-file path and owned directly by the calling Node process.
 * @needs       node:child_process, node:crypto, node:fs, node:net
 * @feeds       src/browser/profile-seed.ts, src/browser/runtime-transport.ts
 * @breaks      KernelFileLockError on contention, unsupported operating systems, lock-file failures, named-pipe failures, or POSIX lock-provider failures.
 * @invariants  The persistent lock file is never unlinked; POSIX retains the locked open file description; Windows retains the first named-pipe server instance derived from the canonical marker path; release is idempotent; process exit releases ownership atomically.
 * @side-effects Creates or opens one lock marker, briefly executes the POSIX lock provider or binds one Windows named pipe, and retains one kernel handle until release.
 * @perf        One synchronous local process invocation on POSIX or one local named-pipe bind on Windows; no resident guardian process.
 * @concurrency A paused caller keeps its kernel handle; acquisition and release are asynchronous so Windows bind/close settlement is observed; termination releases ownership without stale-owner arbitration.
 * @test        tests/unit/kernel-file-lock.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  openSync,
  realpathSync,
} from "node:fs";
import { createServer, type Server } from "node:net";

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
  release(): Promise<void>;
}

interface KernelLockProvider {
  executable: string;
  args: string[];
  contentionExitCode: number;
}

export async function acquireKernelFileLock(
  path: string,
): Promise<KernelFileLock> {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_CREAT | constants.O_RDWR, 0o600);
    if (!fstatSync(descriptor).isFile()) {
      throw new KernelFileLockError(
        "unavailable",
        `Kernel lock path is not a regular file: ${path}`,
      );
    }
    if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
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

  if (process.platform === "win32") {
    let canonicalPath: string;
    try {
      canonicalPath = realpathSync.native(path);
    } catch (error) {
      closeAfterFailedAcquire(
        descriptor,
        path,
        new KernelFileLockError(
          "unavailable",
          `Kernel lock marker path could not be canonicalized at ${path}: ${errorMessage(error)}`,
          { cause: error },
        ),
      );
    }
    try {
      closeSync(descriptor);
    } catch (error) {
      throw new KernelFileLockError(
        "unavailable",
        `Kernel lock marker descriptor could not be closed for ${path}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    return acquireWindowsKernelLock(path, canonicalPath);
  }

  try {
    const provider = kernelLockProvider();
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
    async release(): Promise<void> {
      if (ownedDescriptor === null) return;
      const descriptorToClose = ownedDescriptor;
      ownedDescriptor = null;
      closeSync(descriptorToClose);
    },
  };
}

async function acquireWindowsKernelLock(
  path: string,
  canonicalPath: string,
): Promise<KernelFileLock> {
  const endpoint = windowsLockPipePath(canonicalPath);
  const server = createServer((socket) => socket.destroy());
  try {
    await listen(server, endpoint);
  } catch (error) {
    if (isErrno(error, "EADDRINUSE")) {
      throw new KernelFileLockError(
        "contended",
        `Kernel lock is already held: ${path}`,
        { cause: error },
      );
    }
    throw new KernelFileLockError(
      "unavailable",
      `Windows kernel lock provider failed for ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  let ownedServer: Server | null = server;
  return {
    path,
    async release(): Promise<void> {
      if (ownedServer === null) return;
      const serverToClose = ownedServer;
      ownedServer = null;
      await closeServer(serverToClose, path);
    },
  };
}

function windowsLockPipePath(canonicalPath: string): string {
  const key = createHash("sha256")
    .update(canonicalPath)
    .digest("hex")
    .slice(0, 40);
  return `\\\\.\\pipe\\unicli-kernel-lock-${key}`;
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(endpoint);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function closeServer(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(
          new KernelFileLockError(
            "unavailable",
            `Windows kernel lock provider could not release ${path}: ${error.message}`,
            { cause: error },
          ),
        );
        return;
      }
      resolve();
    });
  });
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

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
