/**
 * @owner       src::runtime::recoverable-file-lock
 * @does        Serialize one filesystem-backed store across processes, reclaim only proven-dead owners, and recover typed lock failures through nested error chains.
 * @needs       Node crypto, filesystem, path, process liveness, and synchronous atomics
 * @feeds       local event and compute-ref persistence boundaries
 * @breaks      Partial owner publication, ABA during stale recovery, or suppressed release failures can lose evidence or deadlock later processes.
 * @invariants  Complete owner bytes are durable before publication; the owner candidate remains hard-linked for the lock lifetime; one reclaimer atomically renames that secondary link and never renames the shared lock name; operation and release failures are both retained.
 * @side-effects Creates, links, renames, and removes owner-only lock records inside one dedicated store root.
 * @perf        One short critical section; contention polls every 4ms and fails after 5s.
 * @concurrency Hard-link publication elects one owner; immutable secondary-link reclamation cannot remove a later lock generation; live or unverifiable owners are never stolen.
 * @test        tests/unit/local-event-log.test.ts, tests/unit/refs.test.ts, and multi-process dogfood
 * @stability   internal
 * @since       2026-07-18
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const LOCK_FILE = ".write.lock";
const CANDIDATE_PREFIX = ".write.lock.candidate.";
const RECLAIM_PREFIX = ".write.lock.reclaim.";
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 4;
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

interface StoreLock {
  fd: number;
  candidatePath: string;
}

interface InspectedStoreLock {
  dev: number;
  ino: number;
  owner?: StoreLockOwner;
}

interface StoreLockOwner {
  pid: number;
  candidateName: string;
}

interface ClaimedOwnerLink {
  claimedPath: string;
  candidatePath: string;
}

export class RecoverableFileLockError extends Error {
  constructor(
    readonly code: "lock_timeout" | "io_error",
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "RecoverableFileLockError";
  }
}

export function findRecoverableFileLockError(
  value: unknown,
  visited = new Set<object>(),
): RecoverableFileLockError | undefined {
  if (!(value instanceof Error) || visited.has(value)) return undefined;
  visited.add(value);
  if (value instanceof RecoverableFileLockError) return value;
  if (value instanceof AggregateError) {
    for (const nested of value.errors) {
      const found = findRecoverableFileLockError(nested, visited);
      if (found) return found;
    }
  }
  return findRecoverableFileLockError(value.cause, visited);
}

export function withRecoverableFileStoreLock<T>(
  rootDir: string,
  operation: () => T,
): T {
  const lockPath = join(rootDir, LOCK_FILE);
  const lock = acquireStoreLock(lockPath);
  let operationFailure: unknown;
  let output: T | undefined;
  try {
    output = operation();
  } catch (error) {
    operationFailure = error;
  }

  let releaseFailure: unknown;
  try {
    releaseStoreLock(lock, lockPath);
  } catch (error) {
    releaseFailure = error;
  }
  if (operationFailure !== undefined && releaseFailure !== undefined) {
    throw new AggregateError(
      [operationFailure, releaseFailure],
      "file-store operation and lock release both failed",
    );
  }
  if (operationFailure !== undefined) throw operationFailure;
  if (releaseFailure !== undefined) throw releaseFailure;
  return output as T;
}

export async function withRecoverableFileStoreLockAsync<T>(
  rootDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = join(rootDir, LOCK_FILE);
  const lock = await acquireStoreLockAsync(lockPath);
  let operationFailure: unknown;
  let output: T | undefined;
  try {
    output = await operation();
  } catch (error) {
    operationFailure = error;
  }

  let releaseFailure: unknown;
  try {
    releaseStoreLock(lock, lockPath);
  } catch (error) {
    releaseFailure = error;
  }
  if (operationFailure !== undefined && releaseFailure !== undefined) {
    throw new AggregateError(
      [operationFailure, releaseFailure],
      "async file-store operation and lock release both failed",
    );
  }
  if (operationFailure !== undefined) throw operationFailure;
  if (releaseFailure !== undefined) throw releaseFailure;
  return output as T;
}

function acquireStoreLock(lockPath: string): StoreLock {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      return acquireStoreLockOnce(lockPath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
        continue;
      }
      if (!isErrno(error, "EEXIST")) throw error;
      if (reclaimDeadStoreLock(lockPath)) continue;
    }
    waitForStoreLock(deadline, lockPath);
  }
}

async function acquireStoreLockAsync(lockPath: string): Promise<StoreLock> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      return acquireStoreLockOnce(lockPath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
        continue;
      }
      if (!isErrno(error, "EEXIST")) throw error;
      if (reclaimDeadStoreLock(lockPath)) continue;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw lockTimeout(lockPath);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(LOCK_RETRY_MS, remaining));
    });
  }
}

function acquireStoreLockOnce(lockPath: string): StoreLock {
  const lock = publishCompleteStoreLock(lockPath);
  try {
    removeAbandonedCandidates(dirname(lockPath), lock.candidatePath);
  } catch (error) {
    try {
      releaseStoreLock(lock, lockPath);
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "file-store candidate cleanup and lock release both failed",
      );
    }
    throw error;
  }
  return lock;
}

function publishCompleteStoreLock(lockPath: string): StoreLock {
  const noFollow =
    typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const candidateName = `${CANDIDATE_PREFIX}${String(process.pid)}.${randomUUID()}`;
  const candidatePath = join(dirname(lockPath), candidateName);
  let fd: number | undefined;
  let published = false;
  try {
    fd = openSync(
      candidatePath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | noFollow,
      0o600,
    );
    const owner = Buffer.from(
      JSON.stringify({
        pid: process.pid,
        candidate_name: candidateName,
        acquired_at: new Date().toISOString(),
      }) + "\n",
      "utf-8",
    );
    const written = writeSync(fd, owner, 0, owner.byteLength);
    if (written !== owner.byteLength) {
      throw lockError("short file-store lock owner write", candidatePath);
    }
    fsyncSync(fd);
    linkSync(candidatePath, lockPath);
    published = true;
    if (process.platform !== "win32") chmodSync(lockPath, 0o600);
    return { fd, candidatePath };
  } catch (error) {
    const failures: unknown[] = [error];
    if (fd !== undefined) {
      try {
        if (published) {
          releaseStoreLock({ fd, candidatePath }, lockPath);
        } else {
          closeSync(fd);
          unlinkIfPresent(candidatePath);
        }
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "file-store lock publication and cleanup both failed",
      );
    }
    throw error;
  }
}

function reclaimDeadStoreLock(lockPath: string): boolean {
  const inspected = inspectStoreLock(lockPath);
  if (!inspected) return true;
  const owner = inspected.owner;
  if (!owner || processIsAlive(owner.pid)) return false;

  const claim = claimOwnerLink(lockPath, owner, inspected);
  if (!claim) return false;
  let releasedMainLock = false;
  try {
    const current = inspectStoreLock(lockPath);
    if (!current) {
      releasedMainLock = true;
      return true;
    }
    if (current.dev !== inspected.dev || current.ino !== inspected.ino) {
      releasedMainLock = true;
      return true;
    }
    unlinkSync(lockPath);
    releasedMainLock = true;
    return true;
  } catch (error) {
    try {
      restoreOwnerLink(claim, inspected);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "file-store stale-lock reclamation and owner-link restore both failed",
      );
    }
    throw error;
  } finally {
    if (releasedMainLock) unlinkIfPresent(claim.claimedPath);
  }
}

function claimOwnerLink(
  lockPath: string,
  owner: StoreLockOwner,
  inspected: InspectedStoreLock,
): ClaimedOwnerLink | undefined {
  const rootDir = dirname(lockPath);
  const candidatePath = join(rootDir, owner.candidateName);
  const reclaimPath = join(
    rootDir,
    `${RECLAIM_PREFIX}${String(process.pid)}.${randomUUID()}`,
  );
  try {
    renameSync(candidatePath, reclaimPath);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    return claimAbandonedReclaimLink(
      rootDir,
      reclaimPath,
      candidatePath,
      inspected,
    );
  }
  assertClaimedIdentity(reclaimPath, inspected);
  return { claimedPath: reclaimPath, candidatePath };
}

function claimAbandonedReclaimLink(
  rootDir: string,
  nextPath: string,
  candidatePath: string,
  inspected: InspectedStoreLock,
): ClaimedOwnerLink | undefined {
  for (const name of readdirSync(rootDir)) {
    const match = /^\.write\.lock\.reclaim\.(\d+)\./.exec(name);
    if (!match) continue;
    const path = join(rootDir, name);
    let stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      if (isErrno(error, "ENOENT")) continue;
      throw error;
    }
    if (stats.dev !== inspected.dev || stats.ino !== inspected.ino) continue;
    const reclaimerPid = Number(match[1]);
    if (
      !Number.isSafeInteger(reclaimerPid) ||
      reclaimerPid <= 0 ||
      processIsAlive(reclaimerPid)
    ) {
      return undefined;
    }
    try {
      renameSync(path, nextPath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
    assertClaimedIdentity(nextPath, inspected);
    return { claimedPath: nextPath, candidatePath };
  }
  return undefined;
}

function restoreOwnerLink(
  claim: ClaimedOwnerLink,
  inspected: InspectedStoreLock,
): void {
  try {
    const existing = lstatSync(claim.candidatePath);
    if (existing.dev !== inspected.dev || existing.ino !== inspected.ino) {
      throw lockError(
        "file-store owner candidate changed during restore: " +
          claim.candidatePath,
        claim.candidatePath,
      );
    }
    unlinkIfPresent(claim.claimedPath);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    renameSync(claim.claimedPath, claim.candidatePath);
  }
}

function assertClaimedIdentity(
  claimedPath: string,
  inspected: InspectedStoreLock,
): void {
  const claimed = lstatSync(claimedPath);
  if (claimed.dev !== inspected.dev || claimed.ino !== inspected.ino) {
    throw lockError(
      "file-store owner link identity changed during reclamation: " +
        claimedPath,
      claimedPath,
    );
  }
}

function inspectStoreLock(lockPath: string): InspectedStoreLock | undefined {
  const noFollow =
    typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, fsConstants.O_RDONLY | noFollow);
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw lockError(
        "file-store lock is not a regular file: " + lockPath,
        lockPath,
      );
    }
    const text = stats.size <= 4096 ? readFileSync(fd, "utf-8") : "";
    return {
      dev: stats.dev,
      ino: stats.ino,
      owner: parseStoreLockOwner(text),
    };
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseStoreLockOwner(text: string): StoreLockOwner | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const pid = record.pid;
    const candidateName = record.candidate_name;
    const acquiredAt = record.acquired_at;
    const expectedPrefix = `${CANDIDATE_PREFIX}${String(pid)}.`;
    return typeof pid === "number" &&
      Number.isSafeInteger(pid) &&
      pid > 0 &&
      typeof candidateName === "string" &&
      basename(candidateName) === candidateName &&
      candidateName.startsWith(expectedPrefix) &&
      typeof acquiredAt === "string" &&
      Number.isFinite(Date.parse(acquiredAt))
      ? { pid, candidateName }
      : undefined;
  } catch {
    return undefined;
  }
}

function removeAbandonedCandidates(
  rootDir: string,
  currentCandidatePath: string,
): void {
  for (const name of readdirSync(rootDir)) {
    const match = /^\.write\.lock\.candidate\.(\d+)\./.exec(name);
    if (!match) continue;
    const path = join(rootDir, name);
    if (path === currentCandidatePath) continue;
    const ownerPid = Number(match[1]);
    if (
      Number.isSafeInteger(ownerPid) &&
      ownerPid > 0 &&
      !processIsAlive(ownerPid)
    ) {
      try {
        if (lstatSync(path).nlink === 1) unlinkIfPresent(path);
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
    }
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

function waitForStoreLock(deadline: number, lockPath: string): void {
  if (Date.now() >= deadline) {
    throw lockTimeout(lockPath);
  }
  Atomics.wait(WAIT_BUFFER, 0, 0, LOCK_RETRY_MS);
}

function lockTimeout(lockPath: string): RecoverableFileLockError {
  return new RecoverableFileLockError(
    "lock_timeout",
    "timed out waiting for file-store lock: " + lockPath,
    lockPath,
  );
}

function releaseStoreLock(lock: StoreLock, lockPath: string): void {
  const failures: unknown[] = [];
  try {
    const held = fstatSync(lock.fd);
    const named = lstatSync(lockPath);
    if (held.dev !== named.dev || held.ino !== named.ino) {
      throw lockError(
        "file-store lock ownership changed: " + lockPath,
        lockPath,
      );
    }
    unlinkSync(lockPath);
  } catch (error) {
    failures.push(error);
  }
  try {
    unlinkIfPresent(lock.candidatePath);
  } catch (error) {
    failures.push(error);
  }
  try {
    closeSync(lock.fd);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "file-store lock release failed");
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

function lockError(message: string, path: string): RecoverableFileLockError {
  return new RecoverableFileLockError("io_error", message, path);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
