import { mkdirSync } from "node:fs";
import { open, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { userHome } from "../user-home.js";
import type { BrowserSessionLease } from "./session-lease.js";

export interface BrowserSessionLeaseLockOptions {
  rootDir?: string;
  retryMs?: number;
  staleMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class BrowserSessionLeaseLockError extends Error {
  code = "browser_lease_locked";
  suggestion =
    "Another command is using the same browser workspace. Retry after it finishes, use --isolated, or choose a different --workspace.";

  constructor(readonly lease: BrowserSessionLease) {
    super(`Browser workspace is locked: ${lease.browser_workspace_id}`);
    this.name = "BrowserSessionLeaseLockError";
  }
}

export async function withBrowserSessionLeaseLock<T>(
  lease: BrowserSessionLease,
  action: () => Promise<T>,
  options: BrowserSessionLeaseLockOptions = {},
): Promise<T> {
  const retryMs = Math.max(0, options.retryMs ?? 0);
  const staleMs = options.staleMs ?? 120_000;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    (async (ms: number) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  const startedAt = now();
  const lockPath = browserSessionLeaseLockPath(lease, options.rootDir);

  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(
          JSON.stringify(
            {
              ...lease,
              pid: process.pid,
              locked_at: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
        return await action();
      } finally {
        await handle.close();
        await rm(lockPath, { force: true });
      }
    } catch (err) {
      if (!isAlreadyExistsError(err)) throw err;
      if (await removeStaleLock(lockPath, staleMs, now)) continue;
      if (now() - startedAt >= retryMs) {
        throw new BrowserSessionLeaseLockError(lease);
      }
      await sleep(Math.min(50, retryMs));
    }
  }
}

export function browserSessionLeaseLockPath(
  lease: BrowserSessionLease,
  rootDir = join(userHome(), ".unicli", "browser-locks"),
): string {
  mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  return join(rootDir, `${safeLockName(lease.browser_session_id)}.lock`);
}

async function removeStaleLock(
  lockPath: string,
  staleMs: number,
  now: () => number,
): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    if (now() - info.mtimeMs <= staleMs) return false;
    if (await lockHolderIsAlive(lockPath)) return false;
    await rm(lockPath, { force: true });
    return true;
  } catch (err) {
    return isNotFoundError(err);
  }
}

function isAlreadyExistsError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "EEXIST"
  );
}

async function lockHolderIsAlive(lockPath: string): Promise<boolean> {
  try {
    const payload = JSON.parse(await readFile(lockPath, "utf-8")) as {
      pid?: unknown;
    };
    return typeof payload.pid === "number" && processIsAlive(payload.pid);
  } catch {
    return false;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (isNoSuchProcessError(err)) return false;
    return true;
  }
}

function isNoSuchProcessError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ESRCH"
  );
}

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}

function safeLockName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}
