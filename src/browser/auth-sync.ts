/**
 * @owner   src/browser/auth-sync.ts
 * @does    Bootstrap CDP automation profiles with cookies from the user's selected local browser profile.
 * @needs   src/browser/local-profiles, src/engine/chromium-cookies, CDP Network domain
 * @feeds   src/engine/steps/browser-helpers.ts
 * @breaks  Unsupported browsers, unavailable cookie stores, or CDP injection failures return structured sync status without logging cookie values.
 */

import type { IPage } from "../types.js";
import { readCookies, type CookieRow } from "../engine/chromium-cookies.js";
import { chromeExpiresToUnixSeconds } from "../engine/cookie-scope.js";
import { currentBrowserInvocationScope } from "./invocation-scope.js";
import {
  browserCookieIdForLocalProfile,
  selectLocalBrowserIdentity,
  type LocalBrowserProfile,
  type LocalProfileDiscoveryOptions,
} from "./local-profiles.js";

export type BrowserAuthSyncResult =
  | {
      status: "synced";
      cookie_count: number;
      profile_id: string;
      profile_selection_source: "explicit" | "preferred";
      domain: string;
    }
  | {
      status: "skipped";
      reason:
        | "missing-domain"
        | "missing-profile"
        | "profile-ambiguous"
        | "unsupported-browser"
        | "no-cookies";
      profile_id?: string;
      profile_selection_source?: "explicit" | "preferred";
      domain?: string;
    }
  | {
      status: "failed";
      reason: string;
      profile_id?: string;
      domain?: string;
    };

export interface BrowserAuthSyncOptions extends LocalProfileDiscoveryOptions {
  domain?: string;
  site?: string;
  profileId?: string;
}

interface CDPCookieParam {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expires?: number;
}

export async function syncLocalProfileCookiesToPage(
  page: Pick<IPage, "sendCDP">,
  opts: BrowserAuthSyncOptions = {},
): Promise<BrowserAuthSyncResult> {
  const domain = authSyncDomain(opts);
  if (!domain) return { status: "skipped", reason: "missing-domain" };

  const scope = currentBrowserInvocationScope();
  const selection = selectLocalBrowserIdentity({
    ...opts,
    profileId:
      opts.profileId ??
      (scope?.provider === "managed" ? scope.profileId : undefined),
  });
  if (selection.status === "ambiguous") {
    return {
      status: "skipped",
      reason: "profile-ambiguous",
      domain,
    };
  }
  if (selection.status === "unavailable") {
    return { status: "skipped", reason: "missing-profile", domain };
  }
  const profile = selection.profile;

  const browser = browserIdForLocalProfile(profile);
  if (!browser) {
    return {
      status: "skipped",
      reason: "unsupported-browser",
      profile_id: profile.id,
      domain,
    };
  }

  let rows: CookieRow[];
  try {
    rows = readCookies({
      browser,
      domain,
      profile: profile.profile_dir,
      userDataDir: profile.user_data_dir,
    });
  } catch (err) {
    return {
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
      profile_id: profile.id,
      domain,
    };
  }

  const cookies = rows
    .filter(
      (row) =>
        !row.hasExpires ||
        chromeExpiresToUnixSeconds(row.expires) > Date.now() / 1000,
    )
    .map(toCDPCookie)
    .filter((cookie) => cookie.name.length > 0 && cookie.domain.length > 0);
  if (cookies.length === 0) {
    return {
      status: "skipped",
      reason: "no-cookies",
      profile_id: profile.id,
      domain,
    };
  }

  try {
    await page.sendCDP("Network.enable");
    await page.sendCDP("Network.setCookies", { cookies });
  } catch (err) {
    return {
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
      profile_id: profile.id,
      domain,
    };
  }

  return {
    status: "synced",
    cookie_count: cookies.length,
    profile_id: profile.id,
    profile_selection_source: selection.source,
    domain,
  };
}

function authSyncDomain(opts: BrowserAuthSyncOptions): string | undefined {
  const explicit = opts.domain?.trim();
  if (explicit) return explicit.replace(/^\./, "");
  const site = opts.site?.trim();
  return site ? `${site}.com` : undefined;
}

function toCDPCookie(row: CookieRow): CDPCookieParam {
  const expires = row.hasExpires
    ? chromeExpiresToUnixSeconds(row.expires)
    : undefined;
  return {
    name: row.name,
    value: row.value,
    domain: row.host,
    path: row.path || "/",
    secure: row.secure,
    httpOnly: row.httpOnly,
    ...(expires ? { expires } : {}),
  };
}

function browserIdForLocalProfile(profile: LocalBrowserProfile) {
  return browserCookieIdForLocalProfile(profile);
}
