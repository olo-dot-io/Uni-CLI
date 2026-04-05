/**
 * Cookie file reader for authenticated adapters.
 *
 * Cookies are stored as JSON in ~/.unicli/cookies/<site>.json
 * Each file contains { "cookie_name": "value", ... }
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  extractCookiesViaCDP,
  saveCookies as saveCookiesToDisk,
} from "./cookie-extractor.js";

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
  if (!/^[a-zA-Z0-9._-]+$/.test(site)) return null;
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

/**
 * Load cookies with CDP fallback.
 * 1. Try disk (fast, synchronous) — ~/.unicli/cookies/<site>.json
 * 2. Try CDP extraction (connects to Chrome debug port)
 * 3. Return null if neither available
 *
 * When CDP extraction succeeds, cookies are saved to disk for future use.
 */
export async function loadCookiesWithCDP(
  site: string,
  domain?: string,
): Promise<Record<string, string> | null> {
  // 1. Try disk first (existing behavior)
  const diskCookies = loadCookies(site);
  if (diskCookies) return diskCookies;

  // 2. Try CDP extraction
  const cookieDomain = domain ?? site.replace(/_/g, ".");
  try {
    const cdpCookies = await extractCookiesViaCDP(cookieDomain);
    if (Object.keys(cdpCookies).length > 0) {
      // Save to disk for future use (site name is already validated by saveCookiesToDisk)
      try {
        saveCookiesToDisk(site, cdpCookies);
      } catch {
        // Non-fatal: disk write failed but we still have the cookies
      }
      return cdpCookies;
    }
  } catch {
    // CDP not available — fall through
  }

  return null;
}
