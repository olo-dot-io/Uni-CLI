/**
 * @owner       src::engine::cookie-refresh
 * @does        Refreshes a site's login session by navigating Chrome to it over
 *              CDP and re-reading cookies, surfacing the real cause of a miss
 *              (no browser / no cookies / error) instead of a bare boolean.
 * @needs       ../browser/page (lazy), ../browser/cdp-client (resolveCdpPort, lazy), ./cookies process-memory handoff
 * @feeds       src::engine::runtime (maybeRefreshCookies — the auto 401/403 path)
 * @breaks      never throws — every failure becomes a typed SessionRefreshOutcome
 * @invariants  navigation (page.goto) happens BEFORE reading cookies so the live
 *              server session is rebuilt; this is the navigate-then-read refresh,
 *              deliberately distinct from cookies.ts acquireCookies(skipDisk)
 *              which is a pure DB/CDP read with no navigation
 * @side-effects connects to Chrome via CDP, navigates a page, and retains refreshed cookies briefly in process memory; never persists
 * @concurrency The page is opened and closed within one call; the latest process-memory handoff for one site/domain wins.
 * @test        tests/unit/engine/cookie-refresh.test.ts
 * @stability   stable
 * @since       2026-05-30
 */

import { rememberTransientCookies } from "./cookies.js";

/** The slice of a live browser page a session refresh needs. */
export interface PageSession {
  goto(url: string, opts: { settleMs: number }): Promise<void>;
  cookies(): Promise<Record<string, string>>;
  close(): Promise<void>;
}

/** Injectable IO so the refresh policy is testable without Chrome or a network. */
export interface SessionRefreshDeps {
  connect(port: number): Promise<PageSession>;
}

/**
 * Typed result of a refresh attempt. Names WHY a refresh did not happen instead
 * of collapsing connect failure, an empty cookie jar, and unexpected errors all
 * to `false` (the old behavior, which left runtime.ts unable to tell the agent
 * what actually went wrong).
 */
export type SessionRefreshOutcome =
  | { status: "refreshed"; site: string; cookieCount: number }
  | { status: "no-browser"; detail: string }
  | { status: "no-cookies"; detail: string }
  | { status: "error"; detail: string };

async function defaultConnect(port: number): Promise<PageSession> {
  const { BrowserPage } = await import("../browser/page.js");
  return BrowserPage.connect(port);
}

export const defaultSessionRefreshDeps: SessionRefreshDeps = {
  connect: defaultConnect,
};

/**
 * Attempt to refresh cookies for a site by navigating Chrome to it and reading
 * the resulting session cookies. Returns a typed outcome; never throws.
 *
 * The refreshed browser session remains the source of truth. A caller retry
 * re-reads it through browser/CDP; background refresh never opts the user into
 * plaintext persistence.
 */
export async function refreshCookies(
  site: string,
  domain?: string,
  deps: SessionRefreshDeps = defaultSessionRefreshDeps,
): Promise<SessionRefreshOutcome> {
  let port: number;
  try {
    const { resolveCdpPort } = await import("../browser/cdp-client.js");
    port = resolveCdpPort();
  } catch (err) {
    return {
      status: "error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  let page: PageSession;
  try {
    page = await deps.connect(port);
  } catch (err) {
    return {
      status: "no-browser",
      detail: `Could not connect to Chrome on CDP port ${port}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  let outcome: SessionRefreshOutcome;
  let refreshedCookies: Record<string, string> | undefined;
  try {
    const targetUrl = domain ? `https://${domain}` : `https://www.${site}.com`;
    await page.goto(targetUrl, { settleMs: 3000 });

    const cookies = await page.cookies();
    if (Object.keys(cookies).length === 0) {
      outcome = {
        status: "no-cookies",
        detail: `No cookies present for ${site} after navigating to ${targetUrl}`,
      };
    } else {
      refreshedCookies = cookies;
      outcome = {
        status: "refreshed",
        site,
        cookieCount: Object.keys(cookies).length,
      };
    }
  } catch (err) {
    outcome = {
      status: "error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    await page.close();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      detail: `Cookie refresh reached ${outcome.status}, but CDP page cleanup failed: ${detail}`,
    };
  }

  if (outcome.status === "refreshed" && refreshedCookies) {
    rememberTransientCookies(site, domain, "cdp", refreshedCookies);
  }
  return outcome;
}
