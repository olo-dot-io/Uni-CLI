/**
 * @owner       src::engine::cookies
 * @does        Cookie front door for adapters — thin projections over the
 *              structured acquisition core in cookie-source.ts (disk read,
 *              header formatting, multi-source load, refresh).
 * @needs       ./cookie-source, ./cookie-extractor (saveCookies)
 * @feeds       adapters (loadCookiesWithCDP/formatCookieHeader), executor,
 *              dispatch/social (refreshCookiesFromBrowser), commands/auth
 * @breaks      loadCookies/loadCookiesWithCDP return null on miss (back-compat);
 *              acquireCookies returns a typed CookieLoadOutcome that names the
 *              real cause — callers that need the cause use acquireCookies
 * @invariants  loadCookiesWithCDP cookies === acquireCookies(...).cookies on load
 * @side-effects acquireCookies persists browser/CDP cookies to disk (best-effort)
 * @test        tests/unit/engine/cookie-source.test.ts, cookie-refresh-format.test.ts
 * @stability   stable
 * @since       2026-05-30
 */

import {
  cookieDir,
  describeCookieFailure,
  loadCookiesWithDiagnostics,
  readDiskCookies,
  resolveCookieDomain,
  type CookieLoadOutcome,
} from "./cookie-source.js";
import { saveCookies as saveCookiesToDisk } from "./cookie-extractor.js";

/**
 * Load cookies for a site from disk. Returns null when the file is absent OR
 * unreadable; callers needing to tell those apart use `acquireCookies`.
 */
export function loadCookies(site: string): Record<string, string> | null {
  const read = readDiskCookies(site);
  return read.kind === "ok" ? read.cookies : null;
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

/** Validate that a cookie file has all required keys. */
export function validateCookies(
  site: string,
  requiredKeys: string[],
): { valid: boolean; missing: string[] } {
  const cookies = loadCookies(site);
  if (!cookies) return { valid: false, missing: requiredKeys };
  const missing = requiredKeys.filter((k) => !(k in cookies));
  return { valid: missing.length === 0, missing };
}

/** Get the cookie directory path (for display in auth commands). */
export function getCookieDir(): string {
  return cookieDir();
}

/**
 * Acquire cookies across disk → browser → CDP, returning the structured outcome
 * (loaded / absent / error+reasons). On a non-disk load, persists to
 * ~/.unicli/cookies for offline reuse. This is the front door for callers that
 * need to surface WHY acquisition failed (Keychain denial, v20 encryption,
 * corrupt file) instead of a bare null.
 */
export async function acquireCookies(
  site: string,
  domain?: string,
  opts: { skipDisk?: boolean } = {},
): Promise<CookieLoadOutcome> {
  const outcome = await loadCookiesWithDiagnostics(
    site,
    domain,
    undefined,
    opts,
  );
  if (outcome.status === "loaded" && outcome.source !== "disk") {
    try {
      saveCookiesToDisk(site, outcome.cookies);
    } catch {
      // REASON: persistence is best-effort; the cookies are already usable for
      // this run, and the next run re-acquires from the same live source.
    }
  }
  return outcome;
}

/**
 * Load cookies with multi-source fallback (disk → browser DB → CDP). Returns
 * null on any miss. Behavior-compatible with every existing adapter consumer;
 * the structured cause is available via `acquireCookies`.
 */
export async function loadCookiesWithCDP(
  site: string,
  domain?: string,
): Promise<Record<string, string> | null> {
  const outcome = await acquireCookies(site, domain);
  return outcome.status === "loaded" ? outcome.cookies : null;
}

export interface CookieRefreshResult {
  ok: boolean;
  site: string;
  domain: string;
  source?: "browser" | "cdp";
  cookieCount?: number;
  cookies?: string[];
  suggestion?: string;
}

/**
 * Re-acquire cookies from the live browser / CDP after an auth failure. Skips
 * the on-disk file (those are the stale cookies that just failed) and reports
 * the real cause on failure rather than a generic message.
 */
export async function refreshCookiesFromBrowser(
  site: string,
  domain?: string,
): Promise<CookieRefreshResult> {
  if (!/^[a-zA-Z0-9._-]+$/.test(site)) {
    return {
      ok: false,
      site,
      domain: domain ?? site,
      suggestion:
        "Site names must contain only letters, digits, dot, dash, or underscore.",
    };
  }

  const cookieDomain = resolveCookieDomain(site, domain);
  const outcome = await acquireCookies(site, domain, { skipDisk: true });

  if (outcome.status === "loaded") {
    return {
      ok: true,
      site,
      domain: cookieDomain,
      source: outcome.source === "cdp" ? "cdp" : "browser",
      cookieCount: Object.keys(outcome.cookies).length,
      cookies: Object.keys(outcome.cookies),
    };
  }

  return {
    ok: false,
    site,
    domain: cookieDomain,
    suggestion: describeCookieFailure(outcome, site, domain).suggestion,
  };
}
