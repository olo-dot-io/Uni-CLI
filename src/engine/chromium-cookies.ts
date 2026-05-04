/**
 * Direct Chromium cookie reader (macOS / Linux / Windows).
 *
 * Reads encrypted cookies from a browser's local SQLite DB and decrypts them
 * with the browser's platform-native key store. No CDP, no extension, no
 * browser launch — works whether the browser is open or closed.
 *
 *   macOS    keychain `security` CLI → AES-128-CBC + 32-byte SHA256 prefix
 *   Linux    libsecret `secret-tool` (peanuts fallback) → AES-128-CBC, no prefix, PBKDF2 iter=1
 *   Windows  Local State + DPAPI → AES-256-GCM + 32-byte SHA256 prefix
 *            v20 cookies (Chrome 127+ App-Bound) surface as
 *            encryption_unsupported with a CDP-fallback suggestion
 *
 * SQLite is read by copy-then-open via the system `sqlite3` binary so that
 * an open browser cannot block the read; WAL/SHM siblings are copied too.
 *
 * Tests at tests/unit/chromium-cookies.test.ts cover the pure path
 * (deriveKey vector, decrypt round-trips per platform, profile picker,
 * resolveCookieDb error codes).
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
  const root = userDataRoot(browser, platform);
  if (!existsSync(root)) {
    throw new ChromiumCookieError(
      "browser_not_installed",
      `${browser} not found at ${root}`,
      `Install ${browser} or pass --browser <other>.`,
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

interface RawCookieRow {
  host: string;
  name: string;
  encrypted: Buffer;
  plain: string;
  path: string;
  expires: number;
  isSecure: number;
  isHttpOnly: number;
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
    `SELECT host_key, name, hex(encrypted_value), value, path, expires_utc, is_secure, is_httponly
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
    if (parts.length < 8) continue;
    const [host, name, hex, plain, path, expires, isSecure, isHttpOnly] = parts;
    rows.push({
      host,
      name,
      encrypted: Buffer.from(hex, "hex"),
      plain,
      path,
      expires: Number(expires) || 0,
      isSecure: Number(isSecure) || 0,
      isHttpOnly: Number(isHttpOnly) || 0,
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
  } = resolveCookieDb(opts.browser, opts.profile);
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
    return rows.map((r) => {
      const value =
        r.encrypted.length > 0
          ? decryptValue(r.encrypted, key, platform)
          : r.plain;
      return {
        host: r.host,
        name: r.name,
        value,
        path: r.path,
        expires: r.expires,
        secure: r.isSecure === 1,
        httpOnly: r.isHttpOnly === 1,
      };
    });
  } finally {
    snap.cleanup();
  }
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
