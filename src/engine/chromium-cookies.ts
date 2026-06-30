/**
 * @owner   src/engine/chromium-cookies.ts
 * @does    Read and decrypt Chromium-family cookie SQLite stores through platform-native keystores.
 * @needs   node:fs, node:os, node:path, node:child_process, src/engine/chromium-cookies-types.ts, src/engine/chromium-cookies-platform.ts
 * @feeds   src/browser/auth-sync.ts, src/commands/auth.ts, scripts/browser-auth-default-acceptance.ts, tests/unit/chromium-cookies.test.ts
 * @breaks  ChromiumCookieError throws on browser discovery, profile discovery, keychain, sqlite, unsupported encryption, and decrypt failures.
 * @invariants Reads from copied SQLite snapshots; callers must explicitly choose the browser/profile/user-data-dir source.
 * @side-effects Creates and removes temporary SQLite snapshots; may invoke sqlite3 and platform keystore CLIs.
 * @perf    Copies only cookie DB files and WAL/SHM siblings before querying.
 * @concurrency Copy-then-open avoids holding locks on a running browser profile.
 * @test    tests/unit/chromium-cookies.test.ts
 * @stability stable
 * @since   2026-06-29
 */

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  ChromiumCookieError,
  type BrowserId,
  type CookieRow,
  type ReadOptions,
} from "./chromium-cookies-types.js";
import {
  KEYSTORE_SPECS,
  currentPlatform,
  decryptValue,
  deriveKey,
  getEncryptionSecret,
  type Platform,
} from "./chromium-cookies-platform.js";

export {
  ChromiumCookieError,
  type BrowserId,
  type CookieRow,
  type ReadOptions,
} from "./chromium-cookies-types.js";
export {
  decryptValue,
  deriveKey,
  type Platform,
} from "./chromium-cookies-platform.js";

/* -------------------------------------------------------------------------- */
/*  Path resolution                                                           */
/* -------------------------------------------------------------------------- */

interface BrowserPathSpec {
  /** Per-platform support root, relative to the platform's user-data home. */
  paths: Partial<Record<Platform, string>>;
  /** Whether profiles live under an extra `User Data` segment. */
  hasUserData: boolean;
}

const BROWSERS: Record<BrowserId, BrowserPathSpec> = {
  chrome: {
    paths: {
      darwin: "Google/Chrome",
      linux: "google-chrome",
      win32: "Google/Chrome/User Data",
    },
    // macOS: no extra User Data segment; Linux: same; Windows: already in path.
    hasUserData: false,
  },
  brave: {
    paths: {
      darwin: "BraveSoftware/Brave-Browser",
      linux: "BraveSoftware/Brave-Browser",
      win32: "BraveSoftware/Brave-Browser/User Data",
    },
    hasUserData: false,
  },
  edge: {
    paths: {
      darwin: "Microsoft Edge",
      linux: "microsoft-edge",
      win32: "Microsoft/Edge/User Data",
    },
    hasUserData: false,
  },
  arc: {
    // Arc has no Linux/Windows build as of 2026-05.
    paths: { darwin: "Arc" },
    hasUserData: true,
  },
  dia: {
    // Dia has macOS only at present.
    paths: { darwin: "Dia" },
    hasUserData: true,
  },
  atlas: {
    // Atlas (OpenAI ChatGPT browser) macOS only at present.
    paths: { darwin: "com.openai.atlas" },
    hasUserData: true,
  },
};

/**
 * Resolve the user-data root for a browser on the current platform.
 *
 *   macOS    $HOME/Library/Application Support/<browser>
 *   Linux    $HOME/.config/<browser>
 *   Windows  %LOCALAPPDATA%/<browser>            (also honors $LOCALAPPDATA)
 *
 * Override the entire root via `UNICLI_BROWSER_HOME` for tests.
 */
function userDataRoot(browser: BrowserId, platform: Platform): string {
  const spec = BROWSERS[browser];
  const rel = spec.paths[platform];
  if (!rel) {
    throw new ChromiumCookieError(
      "browser_not_installed",
      `${browser} has no known path on ${platform}`,
      `Supported: ${Object.keys(spec.paths).join(", ")}.`,
    );
  }

  const override = process.env.UNICLI_BROWSER_HOME;
  let home: string;
  if (override) {
    home = override;
  } else if (platform === "darwin") {
    home = join(homedir(), "Library", "Application Support");
  } else if (platform === "linux") {
    home = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  } else {
    // win32
    home = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  }

  const base = join(home, rel);
  return spec.hasUserData ? join(base, "User Data") : base;
}

/**
 * Enumerate available profiles for a browser. Returns the directory names
 * (e.g. "Default", "Profile 1") that contain a Cookies file, sorted by
 * Cookies-file mtime descending (most-recently-active first).
 */
export function listProfiles(browser: BrowserId): string[] {
  let platform: Platform;
  try {
    platform = currentPlatform();
  } catch {
    return [];
  }
  const spec = BROWSERS[browser];
  if (!spec.paths[platform]) return [];
  const root = userDataRoot(browser, platform);
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const profiles: { name: string; mtime: number }[] = [];
  for (const name of entries) {
    const cookies = locateCookieFile(root, name);
    if (!cookies) continue;
    let mtime = 0;
    try {
      mtime = statSync(cookies).mtimeMs;
    } catch {
      // ignore — keep mtime = 0
    }
    profiles.push({ name, mtime });
  }
  profiles.sort((a, b) => b.mtime - a.mtime);
  return profiles.map((p) => p.name);
}

/**
 * Cookies live at `<profile>/Cookies` on older builds and
 * `<profile>/Network/Cookies` on newer ones (Chromium M96+ moved it). We
 * check `Network/` first because it is the current default and contains the
 * fresher data when both are present.
 */
function locateCookieFile(root: string, profile: string): string | null {
  for (const candidate of [
    join(root, profile, "Network", "Cookies"),
    join(root, profile, "Cookies"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveCookieDb(
  browser: BrowserId,
  profile?: string,
  userDataDir?: string,
): {
  dbPath: string;
  profile: string;
  userDataRoot: string;
  platform: Platform;
} {
  const platform = currentPlatform();
  const spec = BROWSERS[browser];
  if (!spec.paths[platform]) {
    throw new ChromiumCookieError(
      "browser_not_installed",
      `${browser} is not supported on ${platform}`,
      `Supported on: ${Object.keys(spec.paths).join(", ")}.`,
    );
  }
  const root = userDataDir ?? userDataRoot(browser, platform);
  if (!existsSync(root)) {
    throw new ChromiumCookieError(
      "browser_not_installed",
      userDataDir
        ? `${browser} user-data-dir not found at ${root}`
        : `${browser} not found at ${root}`,
      userDataDir
        ? "Pass an existing Chromium user-data-dir."
        : `Install ${browser} or pass --browser <other>.`,
    );
  }
  const chosen = profile ?? listProfiles(browser)[0];
  if (!chosen) {
    throw new ChromiumCookieError(
      "no_profile",
      `${browser} has no profile with a Cookies database under ${root}`,
      `Sign into ${browser} and visit the target site once.`,
    );
  }
  const dbPath = locateCookieFile(root, chosen);
  if (!dbPath) {
    throw new ChromiumCookieError(
      "no_profile",
      `profile "${chosen}" has no Cookies file under ${root}`,
      "Pass a different --profile (try listProfiles).",
    );
  }
  return { dbPath, profile: chosen, userDataRoot: root, platform };
}

/* -------------------------------------------------------------------------- */
/*  SQLite read (copy-then-read via system sqlite3)                           */
/* -------------------------------------------------------------------------- */

/** Resolve the sqlite3 binary, allowing PATH lookup on Linux/Windows. */
function sqliteBinary(): string {
  return process.env.UNICLI_SQLITE_BIN ?? "sqlite3";
}

/** Copy Cookies + WAL/SHM siblings to a tmpdir; return the tmp DB path. */
function snapshotDb(srcDb: string): { dbPath: string; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "unicli-cookies-"));
  const dst = join(tmp, "Cookies");
  copyFileSync(srcDb, dst);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sibling = `${srcDb}${suffix}`;
    if (existsSync(sibling)) {
      try {
        copyFileSync(sibling, `${dst}${suffix}`);
      } catch {
        // Sibling read is opportunistic.
      }
    }
  }
  return {
    dbPath: dst,
    cleanup: () => {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

export interface RawCookieRow {
  host: string;
  name: string;
  encrypted: Buffer;
  plain: string;
  path: string;
  expires: number;
  isSecure: number;
  isHttpOnly: number;
  isPersistent: number;
  hasExpires: number;
}

/**
 * Read cookie rows for a domain. Filters via host_key suffix so
 * `.example.com`, `example.com`, and `sub.example.com` all match.
 *
 * Implementation: shell-out to `sqlite3` reading from stdin. Zero npm deps,
 * zero native compile — `sqlite3` ships with macOS and is widely available
 * on Linux distros and WSL; on Windows we look up via PATH (set
 * `UNICLI_SQLITE_BIN` to override).
 */
function readRowsForDomain(dbPath: string, domain: string): RawCookieRow[] {
  if (!/^[a-zA-Z0-9.-]+$/.test(domain)) {
    throw new ChromiumCookieError(
      "sqlite_failed",
      `invalid domain: "${domain}"`,
      "Domain must contain only letters, digits, dots, and hyphens.",
    );
  }
  // Per RFC 6265, a cookie set on `.bilibili.com` is sent to `api.bilibili.com`.
  // So when an adapter declares `api.bilibili.com`, we must also accept rows
  // whose host_key is the parent `bilibili.com` (with or without leading dot).
  // Walk every ≥2-segment suffix; exclude bare TLD to avoid pulling unrelated
  // domains. PSL edge cases (`co.uk`) are tolerable: matching `.co.uk` would
  // be overbroad but in practice the cookies DB never stores such entries.
  const parts = domain.split(".");
  const candidates: string[] = [];
  for (let i = 0; i <= parts.length - 2; i++) {
    candidates.push(parts.slice(i).join("."));
  }
  const clauses = candidates
    .flatMap((d) => {
      const safe = d.replace(/'/g, "''");
      return [`host_key = '${safe}'`, `host_key = '.${safe}'`];
    })
    .join(" OR ");
  const sql = [
    ".mode list",
    ".separator |",
    ".headers off",
    `SELECT host_key, name, hex(encrypted_value), value, path, expires_utc, is_secure, is_httponly, is_persistent, has_expires
       FROM cookies
       WHERE ${clauses};`,
  ].join("\n");

  let stdout: string;
  try {
    stdout = execFileSync(
      sqliteBinary(),
      ["-readonly", "-bail", `file:${dbPath}?mode=ro&immutable=1`],
      {
        input: sql + "\n.quit\n",
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch (err) {
    throw new ChromiumCookieError(
      "sqlite_failed",
      `sqlite3 read failed: ${(err as Error).message}`,
      "Ensure the sqlite3 binary is on PATH (set UNICLI_SQLITE_BIN to override).",
    );
  }

  const rows: RawCookieRow[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split("|");
    if (parts.length < 10) continue;
    const [
      host,
      name,
      hex,
      plain,
      path,
      expires,
      isSecure,
      isHttpOnly,
      isPersistent,
      hasExpires,
    ] = parts;
    rows.push({
      host,
      name,
      encrypted: Buffer.from(hex, "hex"),
      plain,
      path,
      expires: Number(expires) || 0,
      isSecure: Number(isSecure) || 0,
      isHttpOnly: Number(isHttpOnly) || 0,
      isPersistent: Number(isPersistent) || 0,
      hasExpires: Number(hasExpires) || 0,
    });
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Read all cookies for a domain from a browser's local DB.
 * Returns full structured rows for callers that want secure/httpOnly metadata.
 */
export function readCookies(opts: ReadOptions): CookieRow[] {
  const {
    dbPath,
    platform,
    userDataRoot: root,
  } = resolveCookieDb(opts.browser, opts.profile, opts.userDataDir);
  const secret = getEncryptionSecret(
    opts.browser,
    platform,
    KEYSTORE_SPECS[opts.browser],
    root,
  );
  const key = deriveKey(secret, platform);

  const snap = snapshotDb(dbPath);
  try {
    const rows = readRowsForDomain(snap.dbPath, opts.domain);
    return decodeCookieRows(rows, (enc) => decryptValue(enc, key, platform));
  } finally {
    snap.cleanup();
  }
}

/**
 * Decode raw cookie rows into typed CookieRows, tolerant of individual rows
 * that cannot be decrypted (e.g. a single Chrome v20 App-Bound-Encryption row).
 *
 * Resilience contract (the reason this is a separate, tested function):
 *   - a plain (unencrypted) row never calls `decrypt`;
 *   - an encrypted row that throws is SKIPPED, not fatal — one bad row must not
 *     wipe the whole cookie set (the prior `.map()` threw on the first failure,
 *     and the caller swallowed it → all cookies silently vanished);
 *   - BUT if every encrypted row fails AND nothing else survived, we THROW a
 *     typed ChromiumCookieError instead of returning [] — so "decryption is
 *     broken (likely v20)" is never silently indistinguishable from "no cookies".
 *
 * `decrypt` is injected so the resilience logic is unit-testable without a real
 * keystore.
 */
export function decodeCookieRows(
  rows: RawCookieRow[],
  decrypt: (encrypted: Buffer) => string,
): CookieRow[] {
  const out: CookieRow[] = [];
  let encryptedTotal = 0;
  let encryptedFailed = 0;

  for (const r of rows) {
    let value: string;
    if (r.encrypted.length > 0) {
      encryptedTotal += 1;
      try {
        value = decrypt(r.encrypted);
      } catch {
        encryptedFailed += 1;
        continue;
      }
    } else {
      value = r.plain;
    }
    out.push({
      host: r.host,
      name: r.name,
      value,
      path: r.path,
      expires: r.expires,
      secure: r.isSecure === 1,
      httpOnly: r.isHttpOnly === 1,
      persistent: r.isPersistent === 1,
      hasExpires: r.hasExpires === 1,
    });
  }

  if (
    encryptedTotal > 0 &&
    encryptedFailed === encryptedTotal &&
    out.length === 0
  ) {
    throw new ChromiumCookieError(
      "encryption_unsupported",
      `all ${encryptedTotal} encrypted cookie rows failed to decrypt (likely Chrome v20 App-Bound Encryption)`,
      "Start Chrome with --remote-debugging-port to use the CDP path, or run: unicli auth import <site>",
    );
  }

  return out;
}

/**
 * Convenience: read cookies for a domain and flatten to a name→value record,
 * matching the shape that engine/cookies.ts already passes to fetch headers.
 * Last-write-wins on duplicate names (later host_key entries override earlier).
 */
export function readCookiesAsRecord(opts: ReadOptions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of readCookies(opts)) {
    out[c.name] = c.value;
  }
  return out;
}

/** All known browser ids in priority order for auto-discovery. */
export const BROWSER_IDS: readonly BrowserId[] = [
  "chrome",
  "arc",
  "dia",
  "brave",
  "edge",
  "atlas",
] as const;

/**
 * Find any installed browser whose profile DB exists. Used by the auto path
 * when the caller doesn't specify --browser. Returns [] if no Chromium
 * browser is installed locally, or if the platform isn't supported.
 */
export function detectInstalledBrowsers(): BrowserId[] {
  let platform: Platform;
  try {
    platform = currentPlatform();
  } catch {
    return [];
  }
  return BROWSER_IDS.filter((b) => {
    if (!BROWSERS[b].paths[platform]) return false;
    return listProfiles(b).length > 0;
  });
}
