/**
 * @owner   src/browser/auth-sync.ts
 * @does    Bootstrap CDP automation profiles with cookies from the user's selected local browser profile.
 * @needs   src/browser/local-profiles, src/engine/chromium-cookies, CDP Network domain
 * @feeds   src/engine/steps/browser-helpers.ts
 * @breaks  Unsupported browsers, unavailable cookie stores, or CDP injection failures return structured sync status without logging cookie values.
 */

import type { IPage } from "../types.js";
import {
  readCookies,
  type BrowserId,
  type CookieRow,
} from "../engine/chromium-cookies.js";
import {
  resolvePreferredLocalBrowserProfile,
  type LocalBrowserProfile,
  type LocalProfileDiscoveryOptions,
} from "./local-profiles.js";

const WINDOWS_EPOCH_OFFSET_SECONDS = 11_644_473_600;

export type BrowserAuthSyncResult =
  | {
      status: "synced";
      cookie_count: number;
      profile_id: string;
      domain: string;
    }
  | {
      status: "skipped";
      reason:
        | "missing-domain"
        | "missing-profile"
        | "unsupported-browser"
        | "no-cookies";
      profile_id?: string;
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

  const profile = resolvePreferredLocalBrowserProfile({
    ...opts,
    profileId: opts.profileId,
  });
  if (!profile) {
    return { status: "skipped", reason: "missing-profile", domain };
  }

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
    });
  } catch (err) {
    return {
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
      profile_id: profile.id,
      domain,
    };
  }

  const cookies = rows.map(toCDPCookie).filter((cookie) => {
    return cookie.name.length > 0 && cookie.domain.length > 0;
  });
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
  const expires = chromeExpiresToUnixSeconds(row.expires);
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

function chromeExpiresToUnixSeconds(expiresUtc: number): number | undefined {
  if (!Number.isFinite(expiresUtc) || expiresUtc <= 0) return undefined;
  const unixSeconds = Math.floor(
    expiresUtc / 1_000_000 - WINDOWS_EPOCH_OFFSET_SECONDS,
  );
  return unixSeconds > 0 ? unixSeconds : undefined;
}

function browserIdForLocalProfile(
  profile: LocalBrowserProfile,
): BrowserId | null {
  switch (profile.browser_name) {
    case "Google Chrome":
    case "Chrome Canary":
      return "chrome";
    case "Brave":
      return "brave";
    case "Microsoft Edge":
      return "edge";
    case "Arc":
      return "arc";
    case "Dia":
      return "dia";
    default:
      return null;
  }
}
