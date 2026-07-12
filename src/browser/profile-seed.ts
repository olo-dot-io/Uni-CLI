/**
 * @owner   src/browser/profile-seed.ts
 * @does    Seed Uni-CLI-owned Chrome user-data dirs from local browser profile login state before CDP launch.
 * @needs   node:fs, node:os, node:path, src/browser/local-profiles.ts
 * @feeds   src/browser/launcher.ts, src/browser/doctor.ts, src/commands/browser/index.ts, scripts/browser-auth-default-acceptance.ts, tests/unit/profile-seed.test.ts
 * @breaks  BrowserProfileSeedError throws on unsupported platforms, missing cookie stores, lock contention, source races, manifest corruption, and copy failures.
 * @invariants Seeded profiles live outside real browser user-data dirs; manifest paths use portable POSIX separators; manifest is written only after all required files copy, and fresh seeds require target files to still exist.
 * @side-effects Creates, replaces, and removes files under Uni-CLI-owned automation profile directories and temporary staging directories.
 * @perf    Copies only Local State, profile preferences, and cookie stores instead of whole browser profiles.
 * @concurrency Uses an exclusive sibling lock file and refuses to seed when another seed owns the target.
 * @test    tests/unit/profile-seed.test.ts
 * @stability experimental
 * @since   2026-06-29
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import type { LocalBrowserProfile } from "./local-profiles.js";

export const AUTOMATION_PROFILE_SEED_MANIFEST = ".unicli-profile-seed.json";
export const EPHEMERAL_AUTOMATION_USER_DATA_DIR_PREFIX = join(
  tmpdir(),
  "unicli-chrome-ephemeral-",
);

const SEED_MANIFEST_VERSION = 1;
const COOKIE_STORE_RELATIVE_PATHS = [
  "Cookies",
  posix.join("Network", "Cookies"),
] as const;
const COOKIE_SQLITE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;
const OPTIONAL_PROFILE_FILES = ["Preferences", "Secure Preferences"] as const;
const MAX_SEED_ATTEMPTS = 2;

export type AutomationProfileSeedStatus =
  | "fresh"
  | "missing"
  | "stale"
  | "unsupported"
  | "unseedable"
  | "error";

export type AutomationProfileSeedWriteStatus = "fresh" | "seeded";

export interface AutomationProfileSeedFile {
  relative_path: string;
  size: number;
  mtime_ms: number;
}

export interface AutomationProfileSeedTargetState {
  status: "snapshot" | "runtime-mutated" | "missing" | "error";
  seeded_at_ms?: number;
  latest_mtime_ms?: number;
  changed_files?: string[];
  missing_files?: string[];
  reason?: string;
}

export interface AutomationProfileSeedManifest {
  version: 1;
  seeded_at: string;
  platform: string;
  source_profile: {
    id: string;
    browser_name: string;
    user_data_dir: string;
    profile_dir: string;
    profile_name: string;
  };
  target: {
    user_data_dir: string;
    profile_dir: string;
  };
  files: AutomationProfileSeedFile[];
}

export interface AutomationProfileSeedResult {
  status: AutomationProfileSeedWriteStatus;
  manifest: AutomationProfileSeedManifest;
  manifest_path: string;
  target_user_data_dir: string;
  target_profile_dir: string;
}

export interface AutomationProfileSeedInspection {
  status: AutomationProfileSeedStatus;
  manifest_path: string;
  target_user_data_dir: string;
  target_profile_dir: string;
  source_profile?: {
    id: string;
    browser_name: string;
    profile_dir: string;
    profile_name: string;
  };
  seeded_at?: string;
  target_state?: AutomationProfileSeedTargetState;
  stale_cause?: "source-changed" | "target-missing";
  reason?: string;
}

type SeedManifestRead =
  | { status: "valid"; manifest: AutomationProfileSeedManifest }
  | { status: "missing" }
  | { status: "invalid"; reason: string };

export class BrowserProfileSeedError extends Error {
  readonly code:
    | "unsupported-platform"
    | "missing-source"
    | "missing-cookie-store"
    | "seed-lock-held"
    | "source-changed"
    | "copy-failed"
    | "manifest-invalid";

  constructor(
    code: BrowserProfileSeedError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "BrowserProfileSeedError";
    this.code = code;
  }
}

export function isBrowserEphemeralRequested(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.UNICLI_BROWSER_EPHEMERAL === "1";
}

export function createEphemeralAutomationUserDataDir(): string {
  return mkdtempSync(EPHEMERAL_AUTOMATION_USER_DATA_DIR_PREFIX);
}

export function isEphemeralAutomationUserDataDir(userDataDir: string): boolean {
  return userDataDir.startsWith(EPHEMERAL_AUTOMATION_USER_DATA_DIR_PREFIX);
}

export function seedManifestPath(targetUserDataDir: string): string {
  return join(targetUserDataDir, AUTOMATION_PROFILE_SEED_MANIFEST);
}

export function readAutomationProfileSeedManifest(
  targetUserDataDir: string,
): AutomationProfileSeedManifest | null {
  const state = readAutomationProfileSeedManifestState(targetUserDataDir);
  return state.status === "valid" ? state.manifest : null;
}

export function isRunningSeedIdentityUsable(
  seed: AutomationProfileSeedInspection,
): boolean {
  return (
    seed.status === "fresh" ||
    (seed.status === "stale" && seed.stale_cause === "source-changed")
  );
}

export function inspectAutomationProfileSeed(
  profile: LocalBrowserProfile | null,
  targetUserDataDir: string,
  opts: { platform?: string } = {},
): AutomationProfileSeedInspection {
  const manifestPath = seedManifestPath(targetUserDataDir);
  if (!profile) {
    return {
      status: "missing",
      manifest_path: manifestPath,
      target_user_data_dir: targetUserDataDir,
      target_profile_dir: "Default",
      reason: "No local browser profile source was selected.",
    };
  }

  const targetProfileDir = profile.profile_dir;
  const source = {
    id: profile.id,
    browser_name: profile.browser_name,
    profile_dir: profile.profile_dir,
    profile_name: profile.profile_name,
  };
  const platform = opts.platform ?? process.platform;
  if (!isSeedPlatformSupported(platform)) {
    return {
      status: "unsupported",
      manifest_path: manifestPath,
      target_user_data_dir: targetUserDataDir,
      target_profile_dir: targetProfileDir,
      source_profile: source,
      reason: unsupportedPlatformMessage(platform),
    };
  }

  let fingerprint: AutomationProfileSeedFile[];
  try {
    fingerprint = buildSourceFingerprint(profile);
  } catch (err) {
    if (
      err instanceof BrowserProfileSeedError &&
      err.code === "missing-cookie-store"
    ) {
      return {
        status: "unseedable",
        manifest_path: manifestPath,
        target_user_data_dir: targetUserDataDir,
        target_profile_dir: targetProfileDir,
        source_profile: source,
        reason: err.message,
      };
    }
    return {
      status: "error",
      manifest_path: manifestPath,
      target_user_data_dir: targetUserDataDir,
      target_profile_dir: targetProfileDir,
      source_profile: source,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const manifestState =
    readAutomationProfileSeedManifestState(targetUserDataDir);
  if (manifestState.status === "invalid") {
    return {
      status: "error",
      manifest_path: manifestPath,
      target_user_data_dir: targetUserDataDir,
      target_profile_dir: targetProfileDir,
      source_profile: source,
      reason: manifestState.reason,
    };
  }
  if (manifestState.status === "missing") {
    return {
      status: "missing",
      manifest_path: manifestPath,
      target_user_data_dir: targetUserDataDir,
      target_profile_dir: targetProfileDir,
      source_profile: source,
      reason: "Automation profile has no Uni-CLI seed manifest.",
    };
  }

  const manifest = manifestState.manifest;
  if (
    isManifestSourceFresh(
      manifest,
      profile,
      targetUserDataDir,
      fingerprint,
      platform,
    )
  ) {
    const targetState = inspectTargetSeedFiles(manifest);
    if (targetState.status === "missing" || targetState.status === "error") {
      return {
        status: "stale",
        manifest_path: manifestPath,
        target_user_data_dir: targetUserDataDir,
        target_profile_dir: targetProfileDir,
        source_profile: source,
        seeded_at: manifest.seeded_at,
        target_state: targetState,
        stale_cause: "target-missing",
        reason: targetState.reason,
      };
    }
    return {
      status: "fresh",
      manifest_path: manifestPath,
      target_user_data_dir: targetUserDataDir,
      target_profile_dir: targetProfileDir,
      source_profile: source,
      seeded_at: manifest.seeded_at,
      target_state: targetState,
    };
  }

  return {
    status: "stale",
    manifest_path: manifestPath,
    target_user_data_dir: targetUserDataDir,
    target_profile_dir: targetProfileDir,
    source_profile: source,
    seeded_at: manifest.seeded_at,
    stale_cause: "source-changed",
    reason: "Source profile files changed after the last Uni-CLI seed.",
  };
}

function readAutomationProfileSeedManifestState(
  targetUserDataDir: string,
): SeedManifestRead {
  const path = seedManifestPath(targetUserDataDir);
  if (!existsSync(path)) return { status: "missing" };
  try {
    return {
      status: "valid",
      manifest: parseSeedManifest(readFileSync(path, "utf-8")),
    };
  } catch (err) {
    return {
      status: "invalid",
      reason: `Seed manifest is invalid: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function prepareSeededAutomationProfile(
  profile: LocalBrowserProfile,
  targetUserDataDir: string,
  opts: { platform?: string; force?: boolean } = {},
): AutomationProfileSeedResult {
  const platform = opts.platform ?? process.platform;
  if (!isSeedPlatformSupported(platform)) {
    throw new BrowserProfileSeedError(
      "unsupported-platform",
      unsupportedPlatformMessage(platform),
    );
  }

  const initialFingerprint = buildSourceFingerprint(profile);
  const existingManifest = readAutomationProfileSeedManifest(targetUserDataDir);
  if (
    opts.force !== true &&
    existingManifest &&
    isManifestFresh(
      existingManifest,
      profile,
      targetUserDataDir,
      initialFingerprint,
      platform,
    )
  ) {
    return {
      status: "fresh",
      manifest: existingManifest,
      manifest_path: seedManifestPath(targetUserDataDir),
      target_user_data_dir: targetUserDataDir,
      target_profile_dir: profile.profile_dir,
    };
  }

  return withSeedLock(targetUserDataDir, () => {
    const lockedFingerprint = buildSourceFingerprint(profile);
    const lockedManifest = readAutomationProfileSeedManifest(targetUserDataDir);
    if (
      opts.force !== true &&
      lockedManifest &&
      isManifestFresh(
        lockedManifest,
        profile,
        targetUserDataDir,
        lockedFingerprint,
        platform,
      )
    ) {
      return {
        status: "fresh",
        manifest: lockedManifest,
        manifest_path: seedManifestPath(targetUserDataDir),
        target_user_data_dir: targetUserDataDir,
        target_profile_dir: profile.profile_dir,
      };
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_SEED_ATTEMPTS; attempt++) {
      try {
        return seedProfileOnce(profile, targetUserDataDir, platform);
      } catch (err) {
        lastError = err;
        if (
          !(err instanceof BrowserProfileSeedError) ||
          err.code !== "source-changed" ||
          attempt === MAX_SEED_ATTEMPTS - 1
        ) {
          break;
        }
      }
    }
    throw lastError;
  });
}

function seedProfileOnce(
  profile: LocalBrowserProfile,
  targetUserDataDir: string,
  platform: string,
): AutomationProfileSeedResult {
  const sourceFiles = buildSourceFingerprint(profile);
  const stageDir = `${targetUserDataDir}.seed-${String(process.pid)}-${String(Date.now())}`;
  const backupDir = `${targetUserDataDir}.previous-${String(process.pid)}-${String(Date.now())}`;
  let movedExisting = false;
  try {
    mkdirSync(stageDir, { recursive: true, mode: 0o700 });
    for (const file of sourceFiles) {
      copySourceFile(profile, file.relative_path, stageDir);
    }
    const afterCopyFiles = buildSourceFingerprint(profile);
    if (!sameFingerprint(sourceFiles, afterCopyFiles)) {
      throw new BrowserProfileSeedError(
        "source-changed",
        `Local browser profile changed while Uni-CLI was seeding ${profile.display_name}; retry the command or attach to a live CDP browser.`,
      );
    }

    const manifest: AutomationProfileSeedManifest = {
      version: SEED_MANIFEST_VERSION,
      seeded_at: new Date().toISOString(),
      platform,
      source_profile: {
        id: profile.id,
        browser_name: profile.browser_name,
        user_data_dir: profile.user_data_dir,
        profile_dir: profile.profile_dir,
        profile_name: profile.profile_name,
      },
      target: {
        user_data_dir: targetUserDataDir,
        profile_dir: profile.profile_dir,
      },
      files: sourceFiles,
    };
    writeFileSync(
      join(stageDir, AUTOMATION_PROFILE_SEED_MANIFEST),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );

    if (existsSync(targetUserDataDir)) {
      renameSync(targetUserDataDir, backupDir);
      movedExisting = true;
    }
    renameSync(stageDir, targetUserDataDir);
    if (movedExisting) rmSync(backupDir, { recursive: true, force: true });

    return {
      status: "seeded",
      manifest,
      manifest_path: seedManifestPath(targetUserDataDir),
      target_user_data_dir: targetUserDataDir,
      target_profile_dir: profile.profile_dir,
    };
  } catch (err) {
    rmSync(stageDir, { recursive: true, force: true });
    if (
      movedExisting &&
      !existsSync(targetUserDataDir) &&
      existsSync(backupDir)
    ) {
      renameSync(backupDir, targetUserDataDir);
    }
    if (err instanceof BrowserProfileSeedError) throw err;
    throw new BrowserProfileSeedError(
      "copy-failed",
      `Failed to seed Uni-CLI automation profile from ${profile.display_name}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  } finally {
    rmSync(backupDir, { recursive: true, force: true });
  }
}

function withSeedLock<T>(targetUserDataDir: string, fn: () => T): T {
  const lockPath = `${targetUserDataDir}.seed.lock`;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  let fd: number | null = null;
  try {
    fd = openSync(lockPath, "wx", 0o600);
    writeFileSync(
      fd,
      JSON.stringify({
        pid: process.pid,
        created_at: new Date().toISOString(),
        target_user_data_dir: targetUserDataDir,
      }),
      "utf-8",
    );
    return fn();
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      err.code === "EEXIST"
    ) {
      throw new BrowserProfileSeedError(
        "seed-lock-held",
        `Uni-CLI automation profile seed lock is already held: ${lockPath}. Another browser startup is seeding this profile; retry after it exits.`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    if (fd !== null) {
      closeSync(fd);
      rmSync(lockPath, { force: true });
    }
  }
}

function buildSourceFingerprint(
  profile: LocalBrowserProfile,
): AutomationProfileSeedFile[] {
  const files = sourceRelativePaths(profile);
  return files.map((relativePath) => fileFingerprint(profile, relativePath));
}

function sourceRelativePaths(profile: LocalBrowserProfile): string[] {
  const files = ["Local State"];
  for (const name of OPTIONAL_PROFILE_FILES) {
    const relativePath = posix.join(profile.profile_dir, name);
    if (existsSync(join(profile.user_data_dir, relativePath))) {
      files.push(relativePath);
    }
  }

  let cookieStores = 0;
  for (const cookiePath of COOKIE_STORE_RELATIVE_PATHS) {
    const baseRelativePath = posix.join(profile.profile_dir, cookiePath);
    const baseSource = join(profile.user_data_dir, baseRelativePath);
    if (!existsSync(baseSource)) continue;
    cookieStores += 1;
    for (const suffix of COOKIE_SQLITE_SUFFIXES) {
      const relativePath = `${baseRelativePath}${suffix}`;
      if (existsSync(join(profile.user_data_dir, relativePath))) {
        files.push(relativePath);
      }
    }
  }

  if (!existsSync(join(profile.user_data_dir, "Local State"))) {
    throw new BrowserProfileSeedError(
      "missing-source",
      `Cannot seed ${profile.display_name}: Local State is missing from ${profile.user_data_dir}.`,
    );
  }
  if (cookieStores === 0) {
    throw new BrowserProfileSeedError(
      "missing-cookie-store",
      `Cannot seed ${profile.display_name}: no Cookies or Network/Cookies database exists in ${profile.profile_path}.`,
    );
  }

  return [...new Set(files)].sort();
}

function fileFingerprint(
  profile: LocalBrowserProfile,
  relativePath: string,
): AutomationProfileSeedFile {
  const path = join(profile.user_data_dir, relativePath);
  try {
    const stat = statSync(path);
    if (!stat.isFile()) {
      throw new BrowserProfileSeedError(
        "missing-source",
        `Cannot seed ${profile.display_name}: ${path} is not a regular file.`,
      );
    }
    return {
      relative_path: relativePath,
      size: stat.size,
      mtime_ms: stat.mtimeMs,
    };
  } catch (err) {
    if (err instanceof BrowserProfileSeedError) throw err;
    throw new BrowserProfileSeedError(
      "missing-source",
      `Cannot seed ${profile.display_name}: missing source file ${path}.`,
      { cause: err },
    );
  }
}

function copySourceFile(
  profile: LocalBrowserProfile,
  relativePath: string,
  stageDir: string,
): void {
  const source = join(profile.user_data_dir, relativePath);
  const target = join(stageDir, relativePath);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(source, target);
}

function sameFingerprint(
  left: AutomationProfileSeedFile[],
  right: AutomationProfileSeedFile[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((file, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      file.relative_path === other.relative_path &&
      file.size === other.size &&
      file.mtime_ms === other.mtime_ms
    );
  });
}

function isManifestFresh(
  manifest: AutomationProfileSeedManifest,
  profile: LocalBrowserProfile,
  targetUserDataDir: string,
  files: AutomationProfileSeedFile[],
  platform: string = process.platform,
): boolean {
  return (
    isManifestSourceFresh(
      manifest,
      profile,
      targetUserDataDir,
      files,
      platform,
    ) && targetContainsSeedFiles(manifest)
  );
}

function isManifestSourceFresh(
  manifest: AutomationProfileSeedManifest,
  profile: LocalBrowserProfile,
  targetUserDataDir: string,
  files: AutomationProfileSeedFile[],
  platform: string = process.platform,
): boolean {
  return (
    manifest.version === SEED_MANIFEST_VERSION &&
    manifest.platform === platform &&
    manifest.source_profile.id === profile.id &&
    manifest.source_profile.user_data_dir === profile.user_data_dir &&
    manifest.source_profile.profile_dir === profile.profile_dir &&
    manifest.target.user_data_dir === targetUserDataDir &&
    manifest.target.profile_dir === profile.profile_dir &&
    sameFingerprint(manifest.files, files)
  );
}

function targetContainsSeedFiles(
  manifest: AutomationProfileSeedManifest,
): boolean {
  return manifest.files.every((file) => {
    try {
      return statSync(
        join(manifest.target.user_data_dir, file.relative_path),
      ).isFile();
    } catch {
      return false;
    }
  });
}

function inspectTargetSeedFiles(
  manifest: AutomationProfileSeedManifest,
): AutomationProfileSeedTargetState {
  const seededAtMs = Date.parse(manifest.seeded_at);
  if (!Number.isFinite(seededAtMs)) {
    return {
      status: "error",
      reason: "Seed manifest has an invalid seeded_at timestamp.",
    };
  }

  const missingFiles: string[] = [];
  const changedFiles: string[] = [];
  let latestMtimeMs = 0;
  for (const file of manifest.files) {
    const targetPath = join(manifest.target.user_data_dir, file.relative_path);
    try {
      const stat = statSync(targetPath);
      if (!stat.isFile()) {
        missingFiles.push(file.relative_path);
        continue;
      }
      if (stat.mtimeMs > seededAtMs + 1000) {
        changedFiles.push(file.relative_path);
        latestMtimeMs = Math.max(latestMtimeMs, stat.mtimeMs);
      }
    } catch {
      missingFiles.push(file.relative_path);
    }
  }

  if (missingFiles.length > 0) {
    return {
      status: "missing",
      seeded_at_ms: seededAtMs,
      missing_files: missingFiles,
      reason:
        "Seeded automation profile is missing files recorded in the seed manifest.",
    };
  }

  if (changedFiles.length > 0) {
    return {
      status: "runtime-mutated",
      seeded_at_ms: seededAtMs,
      latest_mtime_ms: latestMtimeMs,
      changed_files: changedFiles,
      reason:
        "Automation Chrome has modified seeded profile files after the seed snapshot.",
    };
  }

  return {
    status: "snapshot",
    seeded_at_ms: seededAtMs,
  };
}

function parseSeedManifest(raw: string): AutomationProfileSeedManifest {
  const parsed = JSON.parse(raw) as Partial<AutomationProfileSeedManifest>;
  if (
    parsed.version !== SEED_MANIFEST_VERSION ||
    typeof parsed.seeded_at !== "string" ||
    typeof parsed.platform !== "string" ||
    typeof parsed.source_profile?.id !== "string" ||
    typeof parsed.source_profile.browser_name !== "string" ||
    typeof parsed.source_profile.user_data_dir !== "string" ||
    typeof parsed.source_profile.profile_dir !== "string" ||
    typeof parsed.source_profile.profile_name !== "string" ||
    typeof parsed.target?.user_data_dir !== "string" ||
    typeof parsed.target.profile_dir !== "string" ||
    !Array.isArray(parsed.files) ||
    !parsed.files.every(isSeedFile)
  ) {
    throw new BrowserProfileSeedError(
      "manifest-invalid",
      "Uni-CLI automation profile seed manifest is malformed.",
    );
  }
  return parsed as AutomationProfileSeedManifest;
}

function isSeedFile(value: unknown): value is AutomationProfileSeedFile {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AutomationProfileSeedFile).relative_path === "string" &&
    typeof (value as AutomationProfileSeedFile).size === "number" &&
    typeof (value as AutomationProfileSeedFile).mtime_ms === "number"
  );
}

function isSeedPlatformSupported(platform: string): boolean {
  return platform === "darwin";
}

function unsupportedPlatformMessage(platform: string): string {
  return `Seeded browser login state is currently supported on macOS only; ${platform} support is not enabled because cookie encryption and profile file locking must be verified first. Use a live CDP browser or UNICLI_BROWSER_EPHEMERAL=1.`;
}
