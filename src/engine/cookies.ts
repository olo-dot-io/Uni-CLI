/**
 * Cookie file reader for authenticated adapters.
 *
 * Cookies are stored as JSON in ~/.unicli/cookies/<site>.json
 * Each file contains { "cookie_name": "value", ... }
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function cookieDir(): string {
  return (
    process.env.UNICLI_COOKIE_DIR ??
    join(process.env.HOME ?? "~", ".unicli", "cookies")
  );
}

/**
 * Load cookies for a site from disk.
 * Returns null if file doesn't exist or is malformed.
 */
export function loadCookies(site: string): Record<string, string> | null {
  const path = join(cookieDir(), `${site}.json`);
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed as Record<string, string>;
  } catch {
    return null;
  }
}

/**
 * Format cookies as an HTTP Cookie header value.
 * Example: "SESSDATA=abc; bili_jct=def"
 */
export function formatCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/**
 * Validate that a cookie file has all required keys.
 */
export function validateCookies(
  site: string,
  requiredKeys: string[],
): { valid: boolean; missing: string[] } {
  const cookies = loadCookies(site);
  if (!cookies) return { valid: false, missing: requiredKeys };

  const missing = requiredKeys.filter((k) => !(k in cookies));
  return { valid: missing.length === 0, missing };
}

/**
 * Get the cookie directory path (for display in auth commands).
 */
export function getCookieDir(): string {
  return cookieDir();
}
