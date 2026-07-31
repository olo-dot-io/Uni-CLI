/**
 * @owner       src::engine::cookies
 * @does        Cookie front door for adapters — structured acquisition, header formatting,
 *              and one-shot invocation-scoped handoff after an explicit auth refresh.
 * @needs       ./cookie-source and ./cookie-storage
 * @feeds       adapters (loadCookiesWithCDP/formatCookieHeader), executor,
 *              dispatch/social (refreshCookiesFromBrowser), commands/auth
 * @breaks      loadCookies/loadCookiesWithCDP return null on miss (back-compat);
 *              acquireCookies returns a typed CookieLoadOutcome that names the
 *              real cause — callers that need the cause use acquireCookies
 * @invariants  Refreshed values are held behind an opaque one-shot capability, consumed by exactly one kernel invocation, and available only to matching site/domain acquisition in that async context; live acquisition never persists.
 * @side-effects Reads explicitly persisted files or browser/CDP cookies and holds an unconsumed refresh capability in process memory; never writes.
 * @concurrency AsyncLocalStorage isolates concurrent invocations; WeakMap-backed capabilities expose no cookie values and are atomically consumed before execution.
 * @test        tests/unit/engine/cookie-source.test.ts, tests/unit/cookies.test.ts
 * @stability   stable
 * @since       2026-05-30
 */

import { AsyncLocalStorage } from "node:async_hooks";

import {
  cookieDir,
  defaultCookieSources,
  describeCookieFailure,
  loadCookiesWithDiagnostics,
  readDiskCookies,
  resolveCookieDomain,
  type CookieCredentialIdentity,
  type CookieLoadOutcome,
  type CookieSources,
} from "./cookie-source.js";

interface CookieInvocationCredential {
  site: string;
  domain: string;
  source: "browser" | "cdp";
  credentialIdentity?: CookieCredentialIdentity;
  cookies: Record<string, string>;
}

declare const cookieInvocationOverrideBrand: unique symbol;
export interface CookieInvocationOverride {
  readonly site: string;
  readonly domain: string;
  readonly source: "browser" | "cdp";
  readonly [cookieInvocationOverrideBrand]: true;
}

const unconsumedCookieOverrides = new WeakMap<
  CookieInvocationOverride,
  CookieInvocationCredential
>();
const invocationCookieStorage =
  new AsyncLocalStorage<CookieInvocationCredential>();

function createCookieInvocationOverride(
  site: string,
  domain: string | undefined,
  source: "browser" | "cdp",
  cookies: Record<string, string>,
  credentialIdentity?: CookieCredentialIdentity,
): CookieInvocationOverride {
  const resolvedDomain = resolveCookieDomain(site, domain);
  const handle = Object.freeze({
    site,
    domain: resolvedDomain,
    source,
  }) as CookieInvocationOverride;
  unconsumedCookieOverrides.set(handle, {
    site,
    domain: resolvedDomain,
    source,
    ...(credentialIdentity ? { credentialIdentity } : {}),
    cookies: { ...cookies },
  });
  return handle;
}

export async function runWithCookieInvocationOverride<T>(
  override: CookieInvocationOverride,
  callback: () => Promise<T>,
): Promise<T> {
  const credential = unconsumedCookieOverrides.get(override);
  if (!credential) {
    throw new Error(
      "cookie invocation override is invalid or has already been consumed",
    );
  }
  // Delete before any await: concurrent consumers cannot both acquire it.
  unconsumedCookieOverrides.delete(override);
  return invocationCookieStorage.run(credential, callback);
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
 * Execute one source-bound cookie acquisition plan. Normal invocation reads
 * persisted site credentials; refresh explicitly selects browser or CDP.
 */
export async function acquireCookies(
  site: string,
  domain?: string,
  opts: {
    skipDisk?: boolean;
    preferCdp?: boolean;
  } = {},
  sources: CookieSources = defaultCookieSources,
): Promise<CookieLoadOutcome> {
  const invocationCredential = invocationCookieStorage.getStore();
  if (
    invocationCredential?.site === site &&
    invocationCredential.domain === resolveCookieDomain(site, domain)
  ) {
    return {
      status: "loaded",
      source: invocationCredential.source,
      cookies: { ...invocationCredential.cookies },
      ...(invocationCredential.credentialIdentity
        ? { credential_identity: invocationCredential.credentialIdentity }
        : {}),
    };
  }
  return loadCookiesWithDiagnostics(site, domain, sources, opts);
}

/**
 * Load persisted cookies. A miss does not change credential authority.
 */
export async function loadCookiesWithCDP(
  site: string,
  domain?: string,
): Promise<Record<string, string> | null> {
  const outcome = await acquireCookies(site, domain);
  return outcome.status === "loaded" ? outcome.cookies : null;
}

export type CookieRefreshResult =
  | {
      ok: true;
      site: string;
      domain: string;
      source: "browser" | "cdp";
      credential_identity?: CookieCredentialIdentity;
      invocation_override: CookieInvocationOverride;
      cookieCount: number;
      /** Names only, never values. */
      cookies: string[];
    }
  | {
      ok: false;
      site: string;
      domain: string;
      suggestion: string;
    };

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
    const invocationOverride = createCookieInvocationOverride(
      site,
      cookieDomain,
      source,
      outcome.cookies,
      outcome.credential_identity,
    );
    return {
      ok: true,
      site,
      domain: cookieDomain,
      source,
      ...(outcome.credential_identity
        ? { credential_identity: outcome.credential_identity }
        : {}),
      invocation_override: invocationOverride,
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
