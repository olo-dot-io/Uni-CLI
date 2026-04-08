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
 */

/**
 * Denied path patterns. Each regex is matched against the absolute path
 * after normalizing backslashes to forward slashes. Patterns are anchored
 * loosely so they catch any user's home directory layout (`/Users/x/.ssh/...`,
 * `/home/y/.ssh/...`, `/root/.ssh/...`).
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
];

/**
 * Returns the matching pattern if `absPath` is sensitive, otherwise undefined.
 *
 * Behavior:
 *   - Backslashes are normalized to forward slash before matching, so a
 *     Windows-style path like `C:\Users\x\.ssh\id_rsa` will be detected even
 *     though Uni-CLI is primarily POSIX.
 *   - Inputs that do not begin with `/` (after normalization) return undefined.
 *     This is a deliberate guard against false positives on relative paths
 *     such as `src/.ssh-helper.ts`. Callers MUST resolve to absolute first.
 *   - Empty string returns undefined.
 */
export function matchSensitivePath(absPath: string): RegExp | undefined {
  if (!absPath) return undefined;
  const normalized = absPath.replace(/\\/g, "/");
  // Strip a Windows drive prefix like "C:" so the path starts with "/" and
  // anchored patterns still match. POSIX paths are unchanged.
  const stripped = normalized.replace(/^[A-Za-z]:/, "");
  if (!stripped.startsWith("/")) return undefined;
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(stripped)) return pattern;
  }
  return undefined;
}

/** Convenience boolean wrapper around `matchSensitivePath`. */
export function isSensitivePath(absPath: string): boolean {
  return matchSensitivePath(absPath) !== undefined;
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
