/**
 * @owner       src::engine::cookie-storage
 * @does        Reads and explicitly persists per-site cookie records with owner-only, atomic filesystem semantics.
 * @needs       node fs/path/os/crypto and UNICLI_COOKIE_DIR/HOME
 * @feeds       cookie acquisition disk source, auth import, browser cookies, cookie storage checks
 * @breaks      Invalid names, symlink reads, non-regular paths, permission failures, and corrupt JSON remain explicit errors.
 * @invariants  POSIX directories are 0700, files are 0600, writes replace atomically, values are strings.
 * @side-effects Explicit writes create/replace cookie files; reads tighten legacy broad permissions before loading.
 * @perf        O(serialized cookie bytes); one fsync per explicit write.
 * @concurrency Same-directory atomic rename prevents partial readers; last completed writer wins.
 * @test        tests/unit/cookie-storage.test.ts, tests/unit/engine/cookie-refresh-format.test.ts
 * @stability   stable
 * @since       2026-07-12
 */

import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const COOKIE_DIRECTORY_MODE = 0o700;
export const COOKIE_FILE_MODE = 0o600;

const SITE_RE = /^[a-zA-Z0-9._-]+$/;

export type DiskRead =
  | { kind: "ok"; cookies: Record<string, string> }
  | { kind: "absent" }
  | { kind: "corrupt"; detail: string };

export function cookieDir(): string {
  return (
    process.env.UNICLI_COOKIE_DIR ??
    join(process.env.HOME ?? homedir(), ".unicli", "cookies")
  );
}

function validateSite(site: string): void {
  if (!SITE_RE.test(site)) {
    throw new Error(
      `Invalid site name: "${site}" — only alphanumeric, dot, dash, underscore allowed`,
    );
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function ensureRegularPath(path: string, expected: "directory" | "file"): void {
  const stat = lstatSync(path);
  const valid =
    !stat.isSymbolicLink() &&
    (expected === "directory" ? stat.isDirectory() : stat.isFile());
  if (!valid) throw new Error(`${path} must be a regular ${expected}`);
}

function tightenMode(path: string, mode: number): void {
  if (process.platform !== "win32") chmodSync(path, mode);
}

function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: COOKIE_DIRECTORY_MODE });
  ensureRegularPath(dir, "directory");
  tightenMode(dir, COOKIE_DIRECTORY_MODE);
}

function secureExistingFile(dir: string, filePath: string): void {
  ensureRegularPath(dir, "directory");
  tightenMode(dir, COOKIE_DIRECTORY_MODE);
  ensureRegularPath(filePath, "file");
  tightenMode(filePath, COOKIE_FILE_MODE);
}

function tightenExistingDestination(filePath: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (stat.isSymbolicLink()) return;
  if (!stat.isFile()) throw new Error(`${filePath} must be a regular file`);
  tightenMode(filePath, COOKIE_FILE_MODE);
}

function parseCookieRecord(raw: string, filePath: string): DiskRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt", detail: `${filePath} is not valid JSON` };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Object.values(parsed).every((value) => typeof value === "string")
  ) {
    return {
      kind: "corrupt",
      detail: `${filePath} is not a {name: string} object`,
    };
  }
  return { kind: "ok", cookies: parsed as Record<string, string> };
}

export function readDiskCookies(site: string): DiskRead {
  try {
    validateSite(site);
  } catch (error) {
    return {
      kind: "corrupt",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const dir = cookieDir();
  const filePath = join(dir, `${site}.json`);
  try {
    secureExistingFile(dir, filePath);
    return parseCookieRecord(readFileSync(filePath, "utf-8"), filePath);
  } catch (error) {
    if (isMissing(error)) return { kind: "absent" };
    return {
      kind: "corrupt",
      detail: `cannot securely read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function cleanupFailedWrite(
  tempPath: string,
  descriptor: number | undefined,
  original: unknown,
): never {
  const failures = [original];
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    unlinkSync(tempPath);
  } catch (error) {
    if (!isMissing(error)) failures.push(error);
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Cookie write and cleanup both failed");
  }
  throw original;
}

export function saveCookies(
  site: string,
  cookies: Record<string, string>,
): string {
  validateSite(site);
  if (!Object.values(cookies).every((value) => typeof value === "string")) {
    throw new Error("Cookie values must all be strings");
  }

  const dir = cookieDir();
  ensurePrivateDirectory(dir);
  const filePath = join(dir, `${site}.json`);
  tightenExistingDestination(filePath);
  const tempPath = join(dir, `.${site}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      tempPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      COOKIE_FILE_MODE,
    );
    if (process.platform !== "win32") {
      fchmodSync(descriptor, COOKIE_FILE_MODE);
    }
    writeFileSync(descriptor, `${JSON.stringify(cookies, null, 2)}\n`, "utf-8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tempPath, filePath);
    tightenMode(filePath, COOKIE_FILE_MODE);
    return filePath;
  } catch (error) {
    return cleanupFailedWrite(tempPath, descriptor, error);
  }
}
