/**
 * Sensitive path deny list — protects credential files from agent access.
 *
 * Modeled on OpenHarness `permissions/checker.py:18-37` but ported to TypeScript
 * with anchored regex patterns instead of fnmatch globs. These rules are
 * unconditional: they apply regardless of permission mode or user config and
 * cannot be overridden. Their purpose is to prevent prompt-injection attacks
 * from steering Uni-CLI into reading or writing well-known credential paths
 * (SSH keys, cloud creds, GPG, kubeconfig, npm tokens, Uni-CLI's own cookies).
 *
 * Caller is responsible for resolving inputs to absolute paths first. Relative
 * paths are intentionally rejected (return undefined / false) to avoid false
 * positives against repo-local files that happen to share the same name.
 *
 * Platform notes:
 *   - On macOS (APFS default) and Windows the filesystem is case-insensitive.
 *     We lowercase the path before matching on those platforms so
 *     `/Users/x/.SSH/id_rsa` is caught.
 *   - On Linux/POSIX the filesystem is case-sensitive and paths match as-is.
 *
 * Symlink handling: use `matchSensitivePathRealpath` or `isSensitivePathRealpath`
 * when the path may be a symlink. They `realpath()` first and then match, which
 * defeats `ln -s ~/.ssh/id_rsa /tmp/pretty.txt` style bypass. The cheaper
 * `matchSensitivePath` variant stays string-only for hot paths that have
 * already canonicalized.
 */

import { realpathSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

/**
 * Denied path patterns. Each regex is matched against the absolute path
 * after normalizing backslashes to forward slashes and (on case-insensitive
 * platforms) lowercasing. Patterns are anchored loosely so they catch any
 * user's home directory layout (`/Users/x/.ssh/...`, `/home/y/.ssh/...`,
 * `/root/.ssh/...`).
 *
 * IMPORTANT: patterns use lowercase literals because `normalizeForMatch`
 * lowercases input on Darwin/Win32. Linux paths stay case-sensitive, so
 * patterns MUST be written in the same case as the real files (all of
 * these are conventionally lowercase).
 */
export const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  // SSH keys and config — entire directory
  /\/\.ssh(\/|$)/,
  // AWS credentials
  /\/\.aws\/credentials$/,
  /\/\.aws\/config$/,
  // GPG keyring — entire directory
  /\/\.gnupg(\/|$)/,
  // Kubernetes config
  /\/\.kube\/config$/,
  // Docker credentials
  /\/\.docker\/config\.json$/,
  // npm auth token
  /\/\.npmrc$/,
  // Uni-CLI's own credential stores
  /\/\.unicli\/cookies\/[^/]+\.json$/,
  /\/\.unicli\/credentials\.json$/,
  // OpenHarness credential stores (interop)
  /\/\.openharness\/credentials\.json$/,
  /\/\.openharness\/copilot_auth\.json$/,
  // GCP credentials
  /\/\.config\/gcloud\/(application_default_credentials|legacy_credentials)/,
  // Azure CLI session + profile
  /\/\.azure\/accesstokens\.json$/,
  /\/\.azure\/azureprofile\.json$/,
  // GitHub CLI host config (contains OAuth token)
  /\/\.config\/gh\/hosts\.yml$/,
  // 1Password CLI session state
  /\/\.config\/op(\/|$)/,
  // PostgreSQL password file
  /\/\.pgpass$/,
  // HTTP / FTP basic-auth login files (used by curl, wget, git, heroku, …)
  /\/\.netrc$/,
  /\/_netrc$/,
  /\/\.wgetrc$/,
  // MySQL client credentials
  /\/\.my\.cnf$/,
  // Rclone remote storage credentials
  /\/\.config\/rclone\/rclone\.conf$/,
];

/**
 * On macOS the default APFS volume is case-insensitive; Windows NTFS is too.
 * Normalize path case on those platforms so `/Users/x/.SSH/id_rsa` matches
 * the same pattern as `/Users/x/.ssh/id_rsa`. POSIX case-sensitive paths
 * stay as-is.
 */
function normalizeForMatch(absPath: string): string {
  const normalized = absPath.replace(/\\/g, "/");
  // Strip a Windows drive prefix like "C:" so the path starts with "/" and
  // anchored patterns still match. POSIX paths are unchanged.
  const stripped = normalized.replace(/^[A-Za-z]:/, "");
  if (process.platform === "darwin" || process.platform === "win32") {
    return stripped.toLowerCase();
  }
  return stripped;
}

/**
 * Returns the matching pattern if `absPath` is sensitive, otherwise undefined.
 *
 * Behavior:
 *   - Backslashes are normalized to forward slash before matching.
 *   - On Darwin/Win32 the path is lowercased before matching (case-insensitive
 *     filesystems).
 *   - Inputs that do not begin with `/` (after normalization) return undefined.
 *     This is a deliberate guard against false positives on relative paths
 *     such as `src/.ssh-helper.ts`. Callers MUST resolve to absolute first.
 *   - Empty string returns undefined.
 *   - Symlinks are NOT followed here. Use `matchSensitivePathRealpath` when
 *     you need to defeat symlink bypass.
 */
export function matchSensitivePath(absPath: string): RegExp | undefined {
  if (!absPath) return undefined;
  const forMatch = normalizeForMatch(absPath);
  if (!forMatch.startsWith("/")) return undefined;
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(forMatch)) return pattern;
  }
  return undefined;
}

/**
 * Symlink-aware variant. Resolves `absPath` through `realpath()` and then
 * matches the canonical target against the deny list. If realpath fails
 * (broken link, missing file, permission denied) we fall back to the
 * string-only check so callers still get a sane answer.
 *
 * Use this in code paths that accept a user-supplied path argument, e.g.
 * `operate upload` and the yaml `exec` step.
 */
export function matchSensitivePathRealpath(
  absPath: string,
): RegExp | undefined {
  if (!absPath) return undefined;
  // First check the literal path — catches the common case cheaply.
  const direct = matchSensitivePath(absPath);
  if (direct) return direct;
  // Then follow symlinks. A broken / missing symlink throws ENOENT — we
  // tolerate that because you cannot upload a non-existent file anyway.
  try {
    const real = realpathSync(pathResolve(absPath));
    if (real !== absPath) {
      return matchSensitivePath(real);
    }
  } catch {
    // realpath failed — fall through with undefined (direct already undef)
  }
  return undefined;
}

/** Convenience boolean wrapper around `matchSensitivePath`. */
export function isSensitivePath(absPath: string): boolean {
  return matchSensitivePath(absPath) !== undefined;
}

/** Symlink-aware convenience wrapper. Prefer in user-input paths. */
export function isSensitivePathRealpath(absPath: string): boolean {
  return matchSensitivePathRealpath(absPath) !== undefined;
}

/**
 * Structured error payload for agent consumers.
 *
 * Emitted to stderr as JSON when an action is blocked. Following the
 * Uni-CLI agent-first error contract: agents read this, understand why,
 * and either back off or ask the user to move the file out of the
 * sensitive location.
 */
export interface SensitivePathDenial {
  error: "sensitive_path_denied";
  /** Absolute path that was attempted */
  path: string;
  /** RegExp source string of the matched rule (for diagnostics) */
  pattern: string;
  /** One-line remediation hint */
  hint: string;
}

/**
 * Build a structured denial payload. Caller is expected to have already
 * confirmed the path is sensitive via `isSensitivePath`; if not, this
 * function still synthesizes a generic message.
 */
export function buildSensitivePathDenial(absPath: string): SensitivePathDenial {
  const matched = matchSensitivePath(absPath);
  return {
    error: "sensitive_path_denied",
    path: absPath,
    pattern: matched ? matched.source : "unknown",
    hint: "This path matches Uni-CLI's sensitive-path deny list (credentials, keys, tokens). Move the file out of this location or use a non-sensitive copy.",
  };
}
