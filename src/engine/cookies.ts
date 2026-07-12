/**
 * @owner       src::engine::cookies
 * @does        Cookie front door for adapters — structured acquisition, header formatting,
 *              and bounded process-memory handoff after an auth refresh.
 * @needs       ./cookie-source and ./cookie-storage
 * @feeds       adapters (loadCookiesWithCDP/formatCookieHeader), executor,
 *              dispatch/social (refreshCookiesFromBrowser), commands/auth
 * @breaks      loadCookies/loadCookiesWithCDP return null on miss (back-compat);
 *              acquireCookies returns a typed CookieLoadOutcome that names the
 *              real cause — callers that need the cause use acquireCookies
 * @invariants  Refreshed values override stale disk state for at most five minutes; live acquisition never persists.
 * @side-effects Reads explicitly persisted files or browser/CDP cookies and retains bounded refresh handoffs in process memory; never writes.
 * @concurrency The latest refresh for one site/domain wins; the handoff cache is capped at 32 entries.
 * @test        tests/unit/engine/cookie-source.test.ts, tests/unit/cookies.test.ts
 * @stability   stable
 * @since       2026-05-30
 */

import {
  cookieDir,
  defaultCookieSources,
  describeCookieFailure,
  loadCookiesWithDiagnostics,
  readDiskCookies,
  resolveCookieDomain,
  type CookieLoadOutcome,
  type CookieSources,
} from "./cookie-source.js";

const TRANSIENT_COOKIE_TTL_MS = 5 * 60 * 1000;
const MAX_TRANSIENT_COOKIE_SESSIONS = 32;

interface TransientCookies {
  source: "browser" | "cdp";
  cookies: Record<string, string>;
  expiresAt: number;
}

const transientCookies = new Map<string, TransientCookies>();

function transientCookieKey(site: string, domain?: string): string {
  return `${site}\u0000${resolveCookieDomain(site, domain)}`;
}

function readTransientCookies(
  site: string,
  domain?: string,
): TransientCookies | undefined {
  const key = transientCookieKey(site, domain);
  const entry = transientCookies.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    transientCookies.delete(key);
    return undefined;
  }
  return entry;
}

export function rememberTransientCookies(
  site: string,
  domain: string | undefined,
  source: "browser" | "cdp",
  cookies: Record<string, string>,
): void {
  const key = transientCookieKey(site, domain);
  transientCookies.delete(key);
  while (transientCookies.size >= MAX_TRANSIENT_COOKIE_SESSIONS) {
    const oldest = transientCookies.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    transientCookies.delete(oldest);
  }
  transientCookies.set(key, {
    source,
    cookies: { ...cookies },
    expiresAt: Date.now() + TRANSIENT_COOKIE_TTL_MS,
  });
}

export function forgetTransientCookies(site: string, domain?: string): void {
  if (domain !== undefined) {
    transientCookies.delete(transientCookieKey(site, domain));
    return;
  }
  const prefix = `${site}\u0000`;
  for (const key of transientCookies.keys()) {
    if (key.startsWith(prefix)) transientCookies.delete(key);
  }
}

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
 * (loaded / absent / error+reasons). Browser/CDP values remain in process memory
 * for this invocation; only explicit auth/browser export commands persist.
 */
export async function acquireCookies(
  site: string,
  domain?: string,
  opts: { skipDisk?: boolean; preferCdp?: boolean } = {},
  sources: CookieSources = defaultCookieSources,
): Promise<CookieLoadOutcome> {
  const transient = readTransientCookies(site, domain);
  if (transient) {
    return {
      status: "loaded",
      source: transient.source,
      cookies: { ...transient.cookies },
    };
  }
  return loadCookiesWithDiagnostics(site, domain, sources, opts);
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
  opts: { preferCdp?: boolean } = {},
  sources: CookieSources = defaultCookieSources,
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
  const outcome = await loadCookiesWithDiagnostics(site, domain, sources, {
    skipDisk: true,
    preferCdp: opts.preferCdp,
  });

  if (outcome.status === "loaded") {
    const source = outcome.source === "cdp" ? "cdp" : "browser";
    rememberTransientCookies(site, cookieDomain, source, outcome.cookies);
    return {
      ok: true,
      site,
      domain: cookieDomain,
      source,
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
