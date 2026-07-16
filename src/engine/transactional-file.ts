/**
 * @owner       src::engine::transactional-file
 * @does        Publish produced file content through a cancellable same-directory temporary file and an atomic rename commit.
 * @needs       node crypto, fs/promises, and path
 * @feeds       browser and native desktop screenshot/evidence artifacts
 * @breaks      Direct destination writes can expose partial artifacts, overwrite a valid prior file on cancellation, or leave staging files behind.
 * @invariants  The destination changes only at rename commit; cancellation before commit preserves any prior destination; failed staging is cleaned; a completed commit returns success even if cancellation races after its linearization point.
 * @side-effects Creates one unique temporary file and atomically replaces the requested destination on success.
 * @perf        One producer write, one rename, and cleanup only on failure.
 * @concurrency Unique same-directory staging paths isolate writers; atomic rename gives readers an old-or-new file view.
 * @test        tests/unit/transactional-file.test.ts, tests/unit/browser-bridge.test.ts, tests/unit/browser-evidence.test.ts
 * @stability   stable
 * @since       2026-07-15
 */

import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface TransactionalFileWriteOptions {
  signal?: AbortSignal;
  mode?: number;
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
  const temporaryPath = join(
    dirname(destinationPath),
    `.${basename(destinationPath)}.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  let committed = false;
  try {
    options.signal?.throwIfAborted();
    await produce(temporaryPath);
    options.signal?.throwIfAborted();
    await rename(temporaryPath, destinationPath);
    committed = true;
  } catch (error) {
    if (!committed) await removeStagingFile(temporaryPath, error);
    if (options.signal?.aborted && isAbortFailure(error)) {
      throw options.signal.reason ?? error;
    }
    throw error;
  }
}

async function removeStagingFile(
  path: string,
  original: unknown,
): Promise<void> {
  try {
    await unlink(path);
  } catch (cleanupError) {
    if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new AggregateError(
        [original, cleanupError],
        "Transactional file write and staging cleanup both failed",
      );
    }
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
