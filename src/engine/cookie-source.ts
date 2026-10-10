/**
 * @owner       src::engine::cookie-source
 * @does        Reuse persisted or selected-profile credentials and execute explicit single-source requests.
 * @needs       ./cookie-storage, ./chromium-cookies (lazy), ./cookie-extractor (lazy), ../browser/local-profiles (lazy)
 * @feeds       src::engine::cookies (loadCookies/loadCookiesWithCDP/acquireCookies
 *              projections), src::engine::executor (auth error detail)
 * @breaks      Acquisition failures become CookieLoadOutcome errors; cancellation propagates to the invocation owner.
 * @invariants  Automatic reads retain an explicit profile selection; explicit source requests never fall through to another source.
 * @side-effects disk reads tighten legacy permissions; default sources read browser DB / CDP into memory
 * @perf        disk O(file); browser reads one explicitly or unambiguously selected profile
 * @concurrency stateless; sources own their own IO
 * @test        tests/unit/engine/cookie-source.test.ts
 * @stability   experimental
 * @since       2026-05-30
 */

import { readDiskCookies, type DiskRead } from "./cookie-storage.js";
import { currentBrowserInvocationScope } from "../browser/invocation-scope.js";
export { cookieDir, readDiskCookies } from "./cookie-storage.js";
export type { DiskRead } from "./cookie-storage.js";
export type CookieSourceName = "disk" | "browser" | "cdp";
export interface CookieAcquisitionOptions {
  source?: CookieSourceName | "auto";
  skipDisk?: boolean;
  preferCdp?: boolean;
  url?: string;
  profileId?: string;
  signal?: AbortSignal;
}
export interface CookieCredentialIdentity {
  profile_id: string;
  selection_source: "explicit" | "preferred";
}

export interface CookieAcquisitionPlan {
  source: CookieSourceName | "auto";
  site: string;
  domain: string;
  credential_identity: CookieCredentialIdentity;
}

/** A typed failure cause from one acquisition source. */
export interface CookieReason {
  source: CookieSourceName;
  /** Stable code, e.g. corrupt_file | keychain_denied | encryption_unsupported | cdp_unavailable. */
  code: string;
  detail: string;
}

/**
 * Result of executing one cookie plan for a site. Discriminated so callers
 * cannot confuse "genuinely not logged in" (absent) with "Keychain denied /
 * file corrupt / Chrome v20" (error) — the distinction the old null collapse
 * destroyed.
 */
export type CookieLoadOutcome =
  | {
      status: "loaded";
      source: CookieSourceName;
      cookies: Record<string, string>;
      credential_identity?: CookieCredentialIdentity;
    }
  | { status: "absent" }
  | { status: "error"; reasons: CookieReason[] };

/** Browser read from one selected profile: a hit, a clean miss, or real errors. */
export type BrowserAttempt =
  | {
      kind: "ok";
      cookies: Record<string, string>;
      credential_identity?: CookieCredentialIdentity;
    }
  | { kind: "none" }
  | { kind: "error"; reasons: CookieReason[] };

/**
 * Injectable acquisition sources. The default wires the real fs / browser DB /
 * CDP; tests pass fakes so the whole policy is verifiable without a network,
 * Keychain, or browser.
 */
export interface CookieSources {
  readDisk(site: string): DiskRead;
  readBrowser(
    domain: string,
    opts?: CookieAcquisitionOptions,
  ): Promise<BrowserAttempt>;
  readCdp(
    domain: string,
    opts?: CookieAcquisitionOptions,
  ): Promise<Record<string, string>>;
}

/** Resolve the cookie domain the same way the legacy loader did. */
export function resolveCookieDomain(site: string, domain?: string): string {
  let resolved = domain ?? site.replace(/_/g, ".");
  if (!resolved.includes(".")) resolved = `${resolved}.com`;
  return resolved;
}

async function defaultReadBrowser(
  domain: string,
  opts: CookieAcquisitionOptions = {},
): Promise<BrowserAttempt> {
  opts.signal?.throwIfAborted();
  let mod: typeof import("./chromium-cookies.js");
  let localProfiles: typeof import("../browser/local-profiles.js");
  try {
    [mod, localProfiles] = await Promise.all([
      import("./chromium-cookies.js"),
      import("../browser/local-profiles.js"),
    ]);
  } catch (err) {
    opts.signal?.throwIfAborted();
    return {
      kind: "error",
      reasons: [
        {
          source: "browser",
          code: "module_load_failed",
          detail: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }
  opts.signal?.throwIfAborted();
  const scope = currentBrowserInvocationScope();
  const selection = localProfiles.selectLocalBrowserIdentity({
    profileId:
      opts.profileId ??
      (scope?.provider === "managed" ? scope.profileId : undefined),
  });
  if (selection.status === "ambiguous") {
    return {
      kind: "error",
      reasons: [
        {
          source: "browser",
          code: "profile_ambiguous",
          detail: `Select one browser profile explicitly: ${selection.profile_ids.join(", ")}`,
        },
      ],
    };
  }
  if (selection.status === "unavailable") {
    return selection.requested_profile_id
      ? {
          kind: "error",
          reasons: [
            {
              source: "browser",
              code: "profile_unavailable",
              detail: `Selected browser profile is unavailable: ${selection.requested_profile_id}`,
            },
          ],
        }
      : { kind: "none" };
  }
  const profile = selection.profile;
  const browser = localProfiles.browserCookieIdForLocalProfile(profile);
  if (!browser) {
    return {
      kind: "error",
      reasons: [
        {
          source: "browser",
          code: "unsupported_browser",
          detail: profile.display_name,
        },
      ],
    };
  }
  try {
    const record = mod.readCookiesAsRecord({
      browser,
      domain,
      profile: profile.profile_dir,
      userDataDir: profile.user_data_dir,
      ...(opts.url ? { url: opts.url } : {}),
    });
    return Object.keys(record).length > 0
      ? {
          kind: "ok",
          cookies: record,
          credential_identity: {
            profile_id: profile.id,
            selection_source: selection.source,
          },
        }
      : { kind: "none" };
  } catch (err) {
    const code =
      err instanceof mod.ChromiumCookieError ? err.code : "browser_read_failed";
    return {
      kind: "error",
      reasons: [
        {
          source: "browser",
          code,
          detail: `${profile.display_name}: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
}

async function defaultReadCdp(
  domain: string,
  opts: CookieAcquisitionOptions = {},
): Promise<Record<string, string>> {
  const { extractCookiesViaCDP } = await import("./cookie-extractor.js");
  return extractCookiesViaCDP(domain, undefined, opts.url, opts.signal);
}

export const defaultCookieSources: CookieSources = {
  readDisk: readDiskCookies,
  readBrowser: defaultReadBrowser,
  readCdp: defaultReadCdp,
};

/**
 * Automatic acquisition tries persisted cookies and the selected local profile.
 * Explicit sources and legacy skip/prefer flags retain their single-source meaning.
 */
export function resolveCookieAcquisitionPlan(
  site: string,
  domain?: string,
  opts: CookieAcquisitionOptions = {},
): CookieAcquisitionPlan {
  const resolvedDomain = resolveCookieDomain(site, domain);
  const source =
    opts.source ??
    (opts.preferCdp ? "cdp" : opts.skipDisk ? "browser" : "auto");
  return {
    source,
    site,
    domain: resolvedDomain,
    credential_identity: {
      profile_id:
        source === "disk"
          ? `persisted-site:${site}`
          : source === "cdp"
            ? `cdp-domain:${resolvedDomain}`
            : `browser-profile:${resolvedDomain}`,
      selection_source: "explicit",
    },
  };
}

export async function loadCookiesWithDiagnostics(
  site: string,
  domain?: string,
  sources: CookieSources = defaultCookieSources,
  opts: CookieAcquisitionOptions = {},
): Promise<CookieLoadOutcome> {
  opts.signal?.throwIfAborted();
  const plan = resolveCookieAcquisitionPlan(site, domain, opts);
  if (plan.source === "auto") {
    const disk = await loadCookiesWithDiagnostics(site, domain, sources, {
      ...opts,
      source: "disk",
    });
    if (disk.status === "loaded") return disk;
    if (process.env.UNICLI_COOKIE_NO_BROWSER === "1") return disk;
    const browser = await loadCookiesWithDiagnostics(site, domain, sources, {
      ...opts,
      source: "browser",
    });
    if (browser.status === "loaded") return browser;
    const reasons = [disk, browser].flatMap((result) =>
      result.status === "error" ? result.reasons : [],
    );
    return reasons.length > 0
      ? { status: "error", reasons }
      : { status: "absent" };
  }
  if (plan.source === "disk") {
    const disk = sources.readDisk(site);
    opts.signal?.throwIfAborted();
    if (disk.kind === "ok") {
      if (!Object.values(disk.cookies).some((value) => value.length > 0)) {
        return { status: "absent" };
      }
      return {
        status: "loaded",
        source: "disk",
        cookies: disk.cookies,
        credential_identity: plan.credential_identity,
      };
    }
    if (disk.kind === "corrupt") {
      return {
        status: "error",
        reasons: [
          {
            source: "disk",
            code: "corrupt_file",
            detail: disk.detail,
          },
        ],
      };
    }
    return { status: "absent" };
  }

  if (plan.source === "browser") {
    if (process.env.UNICLI_COOKIE_NO_BROWSER === "1") {
      return {
        status: "error",
        reasons: [
          {
            source: "browser",
            code: "browser_source_disabled",
            detail: "UNICLI_COOKIE_NO_BROWSER=1",
          },
        ],
      };
    }
    const browser = await sources.readBrowser(plan.domain, opts);
    opts.signal?.throwIfAborted();
    if (
      browser.kind === "ok" &&
      Object.values(browser.cookies).some((value) => value.length > 0)
    ) {
      return {
        status: "loaded",
        source: "browser",
        cookies: browser.cookies,
        credential_identity:
          browser.credential_identity ?? plan.credential_identity,
      };
    }
    return browser.kind === "error"
      ? { status: "error", reasons: browser.reasons }
      : { status: "absent" };
  }

  try {
    const cdp = await sources.readCdp(plan.domain, opts);
    opts.signal?.throwIfAborted();
    return Object.values(cdp).some((value) => value.length > 0)
      ? {
          status: "loaded",
          source: "cdp",
          cookies: cdp,
          credential_identity: plan.credential_identity,
        }
      : { status: "absent" };
  } catch (err) {
    opts.signal?.throwIfAborted();
    return {
      status: "error",
      reasons: [
        {
          source: "cdp",
          code: "cdp_unavailable",
          detail: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }
}

/**
 * Turn a non-loaded outcome into an agent-actionable message + suggestion.
 * This is where the no-silent-failure win is spent: Keychain denial, v20
 * encryption, and a corrupt file each get a DISTINCT next step instead of the
 * legacy one-size-fits-all "run unicli auth setup".
 */
export function describeCookieFailure(
  outcome: Exclude<CookieLoadOutcome, { status: "loaded" }>,
  site: string,
  domain?: string,
): { message: string; suggestion: string; retryable: boolean } {
  const d = resolveCookieDomain(site, domain);
  if (outcome.status === "absent") {
    return {
      message: `No cookies found for "${site}".`,
      suggestion: `Sign in to https://${d} in Chrome, then run: unicli auth import ${site} --domain ${d}`,
      retryable: false,
    };
  }
  const codes = outcome.reasons.map((r) => `${r.source}:${r.code}`).join(", ");
  const has = (code: string) => outcome.reasons.some((r) => r.code === code);
  let suggestion: string;
  if (has("keychain_denied")) {
    suggestion = `Chrome cookie decryption was denied by the macOS Keychain. Grant access when prompted, or run: unicli auth import ${site} --domain ${d}`;
  } else if (has("encryption_unsupported")) {
    suggestion = `Windows v20 cookies require the browser API. Connect the Uni-CLI extension in the intended Chrome profile, run unicli browser doctor --json, then explicitly import from that CDP/native session with unicli auth import ${site} --domain ${d} --cdp.`;
  } else if (has("profile_ambiguous") || has("profile_unavailable")) {
    suggestion =
      "Run unicli browser profiles --json and set UNICLI_BROWSER_PROFILE_ID to the intended profile id, then retry.";
  } else if (has("corrupt_file")) {
    suggestion = `The saved cookie file is unreadable. Re-import: unicli auth import ${site} --domain ${d}`;
  } else {
    suggestion = `Could not acquire cookies (${codes}). Sign in to https://${d}, then run: unicli auth import ${site} --domain ${d}`;
  }
  return {
    message: `Failed to load cookies for "${site}" — ${codes}.`,
    suggestion,
    retryable: false,
  };
}
