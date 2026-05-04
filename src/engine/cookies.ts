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
 * Load cookies with multi-source fallback.
 *
 * Precedence (each falls through silently to the next on miss):
 *   1. ~/.unicli/cookies/<site>.json       — explicit user import
 *   2. browser local DB (Chrome/Arc/Dia/…) — direct SQLite read, no browser launch
 *   3. CDP                                  — connects to Chrome debug port (legacy)
 *
 * The browser disk source is the new default for `strategy: cookie` adapters:
 * it works whether the browser is open or closed, never opens a new tab, and
 * needs neither extension nor daemon. Successful reads are persisted to
 * ~/.unicli/cookies for offline reuse.
 *
 * Set `UNICLI_COOKIE_NO_BROWSER=1` to skip the browser-disk step (e.g., in CI
 * where the macOS Keychain prompt would block).
 */
export async function loadCookiesWithCDP(
  site: string,
  domain?: string,
): Promise<Record<string, string> | null> {
  // 1. ~/.unicli/cookies first
  const diskCookies = loadCookies(site);
  if (diskCookies) return diskCookies;

  // Resolve the cookie domain once for both browser and CDP paths.
  let cookieDomain = domain ?? site.replace(/_/g, ".");
  if (!cookieDomain.includes(".")) {
    cookieDomain = `${cookieDomain}.com`;
  }

  // 2. Direct browser disk read (no launch, no CDP, no extension).
  if (process.env.UNICLI_COOKIE_NO_BROWSER !== "1") {
    const browserCookies = await loadFromInstalledBrowser(cookieDomain);
    if (browserCookies && Object.keys(browserCookies).length > 0) {
      try {
        saveCookiesToDisk(site, browserCookies);
      } catch {
        // Non-fatal — caller still gets the cookies.
      }
      return browserCookies;
    }
  }

  // 3. CDP fallback for users running Chrome with --remote-debugging-port.
  try {
    const cdpCookies = await extractCookiesViaCDP(cookieDomain);
    if (Object.keys(cdpCookies).length > 0) {
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

/**
 * Try each installed Chromium browser in priority order until one yields
 * cookies for the domain. Failures (browser not installed, Keychain denied,
 * unsupported encryption) fall through silently — the next source handles it.
 */
async function loadFromInstalledBrowser(
  domain: string,
): Promise<Record<string, string> | null> {
  let mod: typeof import("./chromium-cookies.js");
  try {
    mod = await import("./chromium-cookies.js");
  } catch {
    return null;
  }
  const installed = mod.detectInstalledBrowsers();
  for (const browser of installed) {
    try {
      const record = mod.readCookiesAsRecord({ browser, domain });
      if (Object.keys(record).length > 0) return record;
    } catch {
      // Move on to the next browser.
    }
  }
  return null;
}
