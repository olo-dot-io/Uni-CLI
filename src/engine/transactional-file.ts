/**
 * @owner       src::engine::transactional-file
 * @does        Publish produced file content through a cancellable same-directory temporary file and an atomic rename commit.
 * @needs       node crypto, fs/promises, and path
 * @feeds       browser and native desktop screenshot/evidence artifacts
 * @breaks      Direct destination writes can expose partial artifacts, overwrite a valid prior file on cancellation, or leave staging files behind.
 * @invariants  The destination changes only at rename commit; staging lives in a hidden same-directory workspace while its producer-facing basename remains non-hidden and retains the destination extension; cancellation before commit preserves any prior destination; failed staging is cleaned; a completed commit returns success even if cancellation races after its linearization point.
 * @side-effects Creates one unique hidden staging directory and temporary file, then atomically replaces the requested destination on success.
 * @perf        One producer write, one rename, and one empty-directory removal, plus cleanup on failure.
 * @concurrency Unique same-directory staging workspaces isolate writers; atomic rename gives readers an old-or-new file view.
 * @test        tests/unit/transactional-file.test.ts, tests/unit/browser-bridge.test.ts, tests/unit/browser-evidence.test.ts
 * @stability   stable
 * @since       2026-07-15
 */

import { mkdtemp, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

export interface TransactionalFileWriteOptions {
  signal?: AbortSignal;
  mode?: number;
}

export class TransactionalFileCleanupError extends Error {
  readonly code = "post_commit_cleanup_failed";
  readonly committed = true;
  readonly retryable = false;
  readonly suggestion: string;

  constructor(
    readonly destinationPath: string,
    cause: unknown,
  ) {
    super(
      `Published ${destinationPath}, but its staging workspace could not be removed`,
      {
        cause,
      },
    );
    this.name = "TransactionalFileCleanupError";
    this.suggestion = `Keep the committed artifact at ${destinationPath}; inspect and remove its sibling .<name>.<pid>.* staging directory without replaying the producer.`;
  }
}

export async function writeFileTransactionally(
  destinationPath: string,
  data: Uint8Array,
  options: TransactionalFileWriteOptions = {},
): Promise<void> {
  await publishFileTransactionally(
    destinationPath,
    async (temporaryPath) => {
      await writeFile(temporaryPath, data, {
        flag: "wx",
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    },
    options,
  );
}

export async function publishFileTransactionally(
  destinationPath: string,
  produce: (temporaryPath: string) => Promise<void>,
  options: TransactionalFileWriteOptions = {},
): Promise<void> {
  const extension = extname(destinationPath);
  const stem = basename(destinationPath, extension);
  const stagingStem = stem.replace(/^\.+/, "") || "artifact";
  options.signal?.throwIfAborted();
  const stagingDirectory = await mkdtemp(
    join(dirname(destinationPath), `.${stagingStem}.${String(process.pid)}.`),
  );
  const temporaryPath = join(stagingDirectory, `artifact.tmp${extension}`);
  let committed = false;
  try {
    options.signal?.throwIfAborted();
    await produce(temporaryPath);
    options.signal?.throwIfAborted();
    await rename(temporaryPath, destinationPath);
    committed = true;
    try {
      await rmdir(stagingDirectory);
    } catch (error) {
      throw new TransactionalFileCleanupError(destinationPath, error);
    }
  } catch (error) {
    if (!committed) {
      await removeStagingWorkspace(stagingDirectory, temporaryPath, error);
    }
    if (options.signal?.aborted && isAbortFailure(error)) {
      throw options.signal.reason ?? error;
    }
    throw error;
  }
}

async function removeStagingWorkspace(
  directory: string,
  path: string,
  original: unknown,
): Promise<void> {
  const cleanupErrors: unknown[] = [];
  try {
    await unlink(path);
  } catch (cleanupError) {
    if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
      cleanupErrors.push(cleanupError);
    }
  }
  try {
    await rmdir(directory);
  } catch (cleanupError) {
    if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
      cleanupErrors.push(cleanupError);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [original, ...cleanupErrors],
      "Transactional file write and staging cleanup both failed",
    );
  }
}

function isAbortFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}
