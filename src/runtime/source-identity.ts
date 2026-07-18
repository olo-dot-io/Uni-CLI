/**
 * @owner       src::runtime::source-identity
 * @does        Identify the exact Git revision and dirty source content that produced a local Uni-CLI process.
 * @needs       node child_process, crypto, fs, path, and url
 * @feeds       local event records and the packaged build-identity artifact
 * @breaks      Git or packaged-metadata failures become an explicit unknown source state; malformed build identity is never trusted.
 * @invariants  Dirty digests cover HEAD, tracked binary diff bytes, and every untracked path/mode/content byte; no source path or diff content leaves this module.
 * @side-effects Reads packaged metadata or Git/worktree files and invokes local Git commands; caches one process identity.
 * @perf        One bounded-memory stabilized worktree scan per process; clean worktrees avoid file-content hashing.
 * @concurrency Metadata brackets two content passes; disagreement yields unknown rather than a mixed-generation digest.
 * @test        tests/unit/source-identity.test.ts, tests/unit/local-event-log.test.ts
 * @stability   stable
 * @since       2026-07-18
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type ServiceSourceState = "clean" | "dirty" | "unknown" | "packaged";

export interface ServiceSourceIdentity {
  revision?: string;
  state?: ServiceSourceState;
  digest?: string;
}

interface PackagedBuildIdentity {
  schema_version: 1;
  revision?: string;
  state: "clean" | "dirty" | "unknown";
  digest?: string;
}

const BUILD_IDENTITY_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "build-identity.json",
);
const MAX_BUILD_IDENTITY_BYTES = 4 * 1024;
const HASH_BUFFER_BYTES = 64 * 1024;
const GIT_OUTPUT_BYTES = 128 * 1024 * 1024;

let cachedServiceSourceIdentity: ServiceSourceIdentity | null = null;

export function serviceSourceIdentity(): ServiceSourceIdentity {
  if (cachedServiceSourceIdentity !== null) {
    return cachedServiceSourceIdentity;
  }
  const explicit = process.env.UNICLI_BUILD_REVISION;
  if (explicit && isRevision(explicit)) {
    cachedServiceSourceIdentity = {
      revision: explicit.toLowerCase(),
      state: "packaged",
    };
    return cachedServiceSourceIdentity;
  }
  const packaged = readPackagedBuildIdentity(BUILD_IDENTITY_FILE);
  if (packaged) {
    cachedServiceSourceIdentity = packaged;
    return cachedServiceSourceIdentity;
  }
  cachedServiceSourceIdentity = computeWorktreeSourceIdentity(
    findGitWorktree(dirname(fileURLToPath(import.meta.url))),
  );
  return cachedServiceSourceIdentity;
}

export function computeWorktreeSourceIdentity(
  worktreeRoot: string | undefined,
): ServiceSourceIdentity {
  if (!worktreeRoot) return { state: "unknown" };
  let revision: string | undefined;
  try {
    revision = gitOutput(worktreeRoot, ["rev-parse", "--verify", "HEAD"])
      .toString("utf-8")
      .trim()
      .toLowerCase();
    if (!isRevision(revision)) return { state: "unknown" };

    const before = readDirtySourceSnapshot(worktreeRoot);
    const firstDigest =
      before.status.length === 0
        ? undefined
        : digestDirtySourceSnapshot(worktreeRoot, revision, before);
    const secondDigest =
      before.status.length === 0
        ? undefined
        : digestDirtySourceSnapshot(worktreeRoot, revision, before);
    const after = readDirtySourceSnapshot(worktreeRoot);
    const finalRevision = gitOutput(worktreeRoot, [
      "rev-parse",
      "--verify",
      "HEAD",
    ])
      .toString("utf-8")
      .trim()
      .toLowerCase();
    if (
      finalRevision !== revision ||
      !sourceSnapshotsEqual(before, after) ||
      firstDigest !== secondDigest
    ) {
      return { revision, state: "unknown" };
    }
    if (before.status.length === 0) return { revision, state: "clean" };
    if (!firstDigest) return { revision, state: "unknown" };
    return { revision, state: "dirty", digest: firstDigest };
  } catch {
    return { ...(revision ? { revision } : {}), state: "unknown" };
  }
}

export function buildIdentityDocument(
  identity: ServiceSourceIdentity,
): PackagedBuildIdentity {
  const hasDirtyIdentity =
    identity.state === "dirty" &&
    identity.digest !== undefined &&
    isDigest(identity.digest);
  const state =
    identity.state === "clean"
      ? "clean"
      : hasDirtyIdentity
        ? "dirty"
        : "unknown";
  return {
    schema_version: 1,
    ...(identity.revision && isRevision(identity.revision)
      ? { revision: identity.revision.toLowerCase() }
      : {}),
    state,
    ...(state === "dirty" && identity.digest
      ? { digest: identity.digest }
      : {}),
  };
}

export function _resetSourceIdentityForTests(): void {
  cachedServiceSourceIdentity = null;
}

function findGitWorktree(start: string): string | undefined {
  let current = resolve(start);
  while (true) {
    if (existsSync(resolve(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function readPackagedBuildIdentity(
  path: string,
): ServiceSourceIdentity | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.size > MAX_BUILD_IDENTITY_BYTES) {
      return { state: "unknown" };
    }
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!isPackagedBuildIdentity(parsed)) return { state: "unknown" };
    return {
      ...(parsed.revision ? { revision: parsed.revision } : {}),
      state: parsed.state,
      ...(parsed.digest ? { digest: parsed.digest } : {}),
    };
  } catch {
    return { state: "unknown" };
  }
}

function isPackagedBuildIdentity(
  candidate: unknown,
): candidate is PackagedBuildIdentity {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const identity = candidate as Record<string, unknown>;
  const keys = Object.keys(identity);
  if (
    keys.some(
      (key) =>
        key !== "schema_version" &&
        key !== "revision" &&
        key !== "state" &&
        key !== "digest",
    )
  ) {
    return false;
  }
  if (identity.schema_version !== 1) return false;
  if (
    identity.state !== "clean" &&
    identity.state !== "dirty" &&
    identity.state !== "unknown"
  ) {
    return false;
  }
  if (identity.revision !== undefined && !isRevision(identity.revision)) {
    return false;
  }
  if (identity.digest !== undefined) {
    return identity.state === "dirty" && isDigest(identity.digest);
  }
  return identity.state !== "dirty";
}

function readDirtySourceSnapshot(worktreeRoot: string): {
  status: Buffer;
  diff: Buffer;
  untracked: Buffer;
} {
  return {
    status: gitOutput(worktreeRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]),
    diff: gitOutput(worktreeRoot, ["diff", "--binary", "HEAD", "--"]),
    untracked: gitOutput(worktreeRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
  };
}

function untrackedPaths(paths: Buffer): string[] {
  return paths.toString("utf-8").split("\0").filter(Boolean).sort();
}

function sourceSnapshotsEqual(
  left: ReturnType<typeof readDirtySourceSnapshot>,
  right: ReturnType<typeof readDirtySourceSnapshot>,
): boolean {
  return (
    left.status.equals(right.status) &&
    left.diff.equals(right.diff) &&
    left.untracked.equals(right.untracked)
  );
}

function digestDirtySourceSnapshot(
  worktreeRoot: string,
  revision: string,
  snapshot: ReturnType<typeof readDirtySourceSnapshot>,
): string {
  const digest = createHash("sha256");
  digest.update(revision);
  digest.update("\0status\0");
  digest.update(snapshot.status);
  digest.update("\0diff\0");
  digest.update(snapshot.diff);
  digest.update("\0untracked\0");
  digest.update(snapshot.untracked);
  for (const relativePath of untrackedPaths(snapshot.untracked)) {
    updateDigestFromUntrackedPath(digest, worktreeRoot, relativePath);
  }
  return digest.digest("hex");
}

function updateDigestFromUntrackedPath(
  digest: ReturnType<typeof createHash>,
  worktreeRoot: string,
  relativePath: string,
): void {
  const root = resolve(worktreeRoot);
  const path = resolve(root, relativePath);
  if (path !== root && !path.startsWith(root + sep)) {
    throw new Error("Git returned an untracked path outside the worktree");
  }
  const pathStat = lstatSync(path);
  digest.update("\0path\0");
  digest.update(relativePath);
  digest.update("\0mode\0");
  digest.update(String(pathStat.mode));
  digest.update("\0content\0");
  if (pathStat.isSymbolicLink()) {
    digest.update(readlinkSync(path));
    return;
  }
  if (!pathStat.isFile()) {
    digest.update("non-regular");
    return;
  }

  const noFollow =
    typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== pathStat.dev ||
      opened.ino !== pathStat.ino
    ) {
      throw new Error("Untracked source identity changed before hashing");
    }
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let bytesRead = 0;
    do {
      bytesRead = readSync(fd, buffer, 0, buffer.byteLength, null);
      if (bytesRead > 0) digest.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
    const finished = fstatSync(fd);
    if (
      finished.size !== opened.size ||
      finished.mtimeMs !== opened.mtimeMs ||
      finished.ino !== opened.ino ||
      finished.dev !== opened.dev
    ) {
      throw new Error("Untracked source identity changed while hashing");
    }
  } finally {
    closeSync(fd);
  }
}

function gitOutput(worktreeRoot: string, args: string[]): Buffer {
  return execFileSync("git", args, {
    cwd: worktreeRoot,
    timeout: 5_000,
    maxBuffer: GIT_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function isRevision(candidate: unknown): candidate is string {
  return typeof candidate === "string" && /^[0-9a-f]{7,64}$/i.test(candidate);
}

function isDigest(candidate: unknown): candidate is string {
  return typeof candidate === "string" && /^[0-9a-f]{64}$/.test(candidate);
}
